/**
 * Post-processing.
 *
 * Reads the quality tier and builds Babylon's pipelines to match. Nothing here is read by the simulation, so this file cannot
 * affect an outcome; it is the last stage of presentation.
 *
 * ## Capabilities are checked before construction, not caught after
 *
 * This is the hard-won rule in this file. A post-process that fails does so inside `scene.render()`, one frame after it was built,
 * so a try/catch around the constructor cannot contain it: the game reaches the countdown and then throws every frame.
 *
 * SSAO2 needed two things this way. First `scene.enablePrePassRenderer`, which only exists once the prepass side-effect module is
 * imported, because Babylon is tree-shaken. Then `engine.createMultipleRenderTarget`, which the WebGPU engine does not provide
 * through the same path, and which fails at render time rather than at construction.
 *
 * So both are checked up front, and SSAO is skipped when either is missing. Ambient occlusion is the most optional thing in the
 * renderer; a game that will not run is not a trade worth making for it.
 *
 * ## Rebuild rather than reconfigure
 *
 * Changing tier disposes the pipeline and builds a new one. Several of Babylon's pipeline effects are fixed at construction, and
 * repeatedly toggling effects on a live pipeline leaks render targets. A tier change is a menu action, so one rebuild is
 * imperceptible.
 *
 * ## Why these settings and not stronger ones
 *
 * Bloom threshold sits ABOVE the brightness of ordinary lit geometry, so only the emissive wall strips, tracers and muzzle
 * flashes glow. A lower threshold blooms the lit faces of every box and washes the arena out, which is the usual way bloom ruins
 * a scene rather than improving it.
 *
 * SSAO strength is low and its radius small. SSAO on an axis-aligned greybox is easy to overdo: heavy occlusion in every corner
 * reads as dirt, and a large radius darkens whole walls instead of the joins between them.
 */

import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
/*
 * Attaches enablePrePassRenderer to Scene. SSAO2 calls it, and in a tree-shaken build it does not exist without this import.
 */
import '@babylonjs/core/Rendering/prePassRendererSceneComponent.js';
/* Geometry buffer, used by SSAO2 for normals. Same reasoning: a side-effect import, not a type. */
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent.js';
/* Adds createMultipleRenderTarget to the WebGL engine. The prepass render target needs it. */
import '@babylonjs/core/Engines/Extensions/engine.multiRender.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { QualityTier } from './quality.js';
import { effectivePost } from './quality.js';

/**
 * Bloom threshold.
 *
 * Ordinary lit geometry in this arena peaks around 0.7 luminance. 0.82 sits above that, so only genuinely emissive surfaces
 * cross it. This is the number that decides whether bloom looks like light or like fog.
 */
const BLOOM_THRESHOLD = 0.82;
/** How far bloom spreads. Tight, so a muzzle flash reads as a flash rather than a glow filling the screen. */
const BLOOM_KERNEL = 48;
const BLOOM_SCALE = 0.5;

/** SSAO tuned for 2 to 4 unit boxes: large enough to darken a join, small enough not to shade a whole wall. */
const SSAO_RADIUS = 1.4;
const SSAO_STRENGTH = 0.9;
const SSAO_BASE = 0.1;
/** Samples. 16 is the point where more stops being visible on geometry this simple. */
const SSAO_SAMPLES = 16;

/** Optional capabilities, attached by side-effect imports and absent on some engines. */
type SceneWithPrePass = Scene & { enablePrePassRenderer?: () => unknown };
type EngineWithMultiRender = { createMultipleRenderTarget?: unknown };

export class PostProcessing {
  private pipeline: DefaultRenderingPipeline | null = null;
  private ssao: SSAO2RenderingPipeline | null = null;
  private currentTier: string | null = null;
  private currentLowPower = false;
  /** Base bloom weight for the current tier, so the load factor scales from a fixed value. */
  private baseBloom = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  /**
   * Apply a tier. Cheap to call repeatedly: it returns immediately when nothing changed.
   *
   * The guard matters because main calls this from the same path that applies every other tier change, and a rebuild on every
   * frame would be catastrophic rather than merely wasteful.
   */
  apply(tier: QualityTier, lowPower: boolean): void {
    if (this.currentTier === tier.name && this.currentLowPower === lowPower) return;
    this.currentTier = tier.name;
    this.currentLowPower = lowPower;

    this.dispose();

    const post = effectivePost(tier, lowPower);
    this.baseBloom = post.bloomWeight;

    // Nothing enabled: skip the pipeline entirely rather than building an inert one that still costs a pass.
    const wantsPipeline = post.fxaa || post.bloom || post.toneMapping || post.msaaSamples > 0;
    if (!wantsPipeline) return;

    try {
      const pipeline = new DefaultRenderingPipeline('rearena-post', true, this.scene, [this.camera]);

      pipeline.fxaaEnabled = post.fxaa;
      // 0 means off in Babylon's API, so the tier value passes straight through.
      pipeline.samples = post.msaaSamples;

      pipeline.bloomEnabled = post.bloom;
      if (post.bloom) {
        pipeline.bloomThreshold = BLOOM_THRESHOLD;
        pipeline.bloomWeight = post.bloomWeight;
        pipeline.bloomKernel = BLOOM_KERNEL;
        // Bloom renders at half resolution. Invisible at this kernel size and halves the cost.
        pipeline.bloomScale = BLOOM_SCALE;
      }

      pipeline.imageProcessingEnabled = post.toneMapping;
      if (post.toneMapping && pipeline.imageProcessing) {
        const ip = pipeline.imageProcessing;
        ip.toneMappingEnabled = true;
        /*
         * ACES rather than the standard curve. The standard operator desaturates highlights toward white, which is exactly wrong
         * for a scene whose only bright elements are coloured emissives: an orange muzzle flash would turn cream.
         */
        ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
        ip.exposure = post.exposure;
        ip.contrast = post.contrast;
        // Vignette off: it narrows the effective field of view, which is a gameplay cost in a shooter.
        ip.vignetteEnabled = false;
      }

      // Explicitly off. All of these obscure targets during combat, which is worse than looking plainer.
      pipeline.depthOfFieldEnabled = false;
      pipeline.chromaticAberrationEnabled = false;
      pipeline.grainEnabled = false;
      pipeline.sharpenEnabled = false;

      this.pipeline = pipeline;
    } catch (error) {
      // A pipeline that cannot be built is a missing effect, not a broken game.
      console.info(
        '[rearena] post-processing unavailable:',
        error instanceof Error ? error.message : error,
      );
      this.pipeline = null;
    }

    if (post.ssao) this.buildSsao();
  }

  /**
   * Build SSAO, if the engine can support it.
   *
   * Both checks below are load-bearing, and both were learned from a crash rather than from the documentation:
   *
   * `enablePrePassRenderer` is attached to Scene by a side-effect import. Without it, SSAO2 constructs and immediately throws.
   *
   * `createMultipleRenderTarget` is what the prepass render target needs to allocate its buffers. The WebGPU engine does not
   * expose it through the same path, and the failure surfaces inside scene.render() on the FIRST FRAME, one frame after this
   * function returned successfully. A try/catch here cannot contain that, which is why it has to be a check rather than a catch.
   */
  private buildSsao(): void {
    const scene = this.scene as SceneWithPrePass;
    if (typeof scene.enablePrePassRenderer !== 'function') {
      console.info('[rearena] ambient occlusion unavailable: prepass renderer not registered');
      return;
    }

    const engine = this.scene.getEngine() as unknown as EngineWithMultiRender;
    if (typeof engine.createMultipleRenderTarget !== 'function') {
      /*
       * WebGPU reaches here. Skipping is the right call: the alternative is a scene that reaches the countdown and then throws
       * on every frame, and ambient occlusion is the most optional thing in this renderer.
       */
      console.info(
        '[rearena] ambient occlusion unavailable: this renderer has no multiple render target support',
      );
      return;
    }

    try {
      /*
       * Ratio pair: the SSAO buffer renders at 50% and is combined at full resolution. A full-resolution SSAO buffer is not
       * distinguishable here and costs roughly four times as much.
       */
      const ssao = new SSAO2RenderingPipeline(
        'rearena-ssao',
        this.scene,
        { ssaoRatio: 0.5, blurRatio: 1 },
        [this.camera],
      );
      ssao.radius = SSAO_RADIUS;
      ssao.totalStrength = SSAO_STRENGTH;
      ssao.base = SSAO_BASE;
      ssao.samples = SSAO_SAMPLES;
      // Expensive blur off: the cheap one is enough on flat surfaces and costs a fraction as much.
      ssao.expensiveBlur = false;
      /*
       * Limits how far a sample can be from the surface and still occlude it. Without a bound, a distant wall darkens the floor
       * in front of it and the arena looks grubby rather than grounded.
       */
      ssao.maxZ = 60;
      this.ssao = ssao;
    } catch (error) {
      console.info(
        '[rearena] ambient occlusion unavailable:',
        error instanceof Error ? error.message : error,
      );
      this.ssao = null;
    }
  }

  /**
   * Scale bloom with dynamic resolution.
   *
   * When the renderer drops resolution to hold a frame rate, bloom is the first thing worth reducing: it is the most expensive
   * remaining pass and the least necessary. Reducing rather than disabling avoids a visible pop mid-fight.
   *
   * Scaled from the tier's base weight rather than from the current value, which would compound on every call and fade bloom to
   * nothing over a few seconds.
   */
  setLoadFactor(factor: number): void {
    if (!this.pipeline?.bloomEnabled || this.baseBloom === 0) return;
    if (!Number.isFinite(factor)) return;
    this.pipeline.bloomWeight = this.baseBloom * Math.max(0.3, Math.min(1, factor));
  }

  dispose(): void {
    this.ssao?.dispose();
    this.ssao = null;
    this.pipeline?.dispose();
    this.pipeline = null;
  }
}
