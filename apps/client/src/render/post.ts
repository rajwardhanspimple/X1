/**
 * Post-processing.
 *
 * Reads the quality tier and builds Babylon's pipelines to match. Nothing here is read by the simulation, so this file cannot
 * affect an outcome; it is the last stage of presentation.
 *
 * ## Side-effect imports are load-bearing
 *
 * Babylon is tree-shaken, so capabilities that attach themselves to Scene or Engine at import time have to be imported
 * explicitly. SSAO2 depends on `scene.enablePrePassRenderer`, which only exists once the prepass module is imported; without it
 * the pipeline constructs and then throws on a method that is not there, which crashes the client before the first frame.
 *
 * Everything below is also GUARDED for that reason: a missing capability degrades to a missing effect, never to a game that will
 * not start. A visual effect must never be able to prevent play.
 *
 * ## Rebuild rather than reconfigure
 *
 * Changing tier disposes the pipeline and builds a new one. Several of Babylon's pipeline effects are fixed at construction, and
 * repeatedly toggling effects on a live pipeline leaks render targets. A tier change is a menu action, so one rebuild is
 * imperceptible, and disposal is the only way to be sure nothing is left attached to the camera.
 *
 * ## Why these settings and not stronger ones
 *
 * Bloom threshold sits ABOVE the brightness of ordinary lit geometry, so only the emissive wall strips, tracers and muzzle
 * flashes glow. A lower threshold blooms the lit faces of every box and washes the arena out, which is the usual way bloom ruins
 * a scene rather than improving it.
 *
 * SSAO strength is low and its radius small. SSAO on an axis-aligned greybox is easy to overdo: heavy occlusion in every corner
 * reads as dirt, and a large radius darkens whole walls instead of the joins between them. The radius here is tuned to the 2 to
 * 4 unit cover boxes the arena is built from.
 */

import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
/*
 * Attaches enablePrePassRenderer to Scene. SSAO2 calls it, and in a tree-shaken build it does not exist without this import: the
 * pipeline would construct and then throw "scene.enablePrePassRenderer is not a function" before the first frame.
 */
import '@babylonjs/core/Rendering/prePassRendererSceneComponent.js';
/* Geometry buffer, used by SSAO2 for normals. Same reasoning: a side-effect import, not a type. */
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent.js';
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

/** Scene with the optional prepass capability, which is attached by a side-effect import. */
type SceneWithPrePass = Scene & { enablePrePassRenderer?: () => unknown };

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
   * Build SSAO, if this build of Babylon has the prepass renderer attached.
   *
   * The capability check is deliberate rather than defensive noise: SSAO2 depends on a side-effect import, and if that import is
   * ever dropped by a refactor the failure is a hard crash on startup. Checking turns that into a missing visual effect.
   */
  private buildSsao(): void {
    const scene = this.scene as SceneWithPrePass;
    if (typeof scene.enablePrePassRenderer !== 'function') {
      console.info('[rearena] ambient occlusion unavailable: prepass renderer not registered');
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
