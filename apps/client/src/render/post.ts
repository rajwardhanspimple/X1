/**
 * Post-processing.
 *
 * Reads the quality tier and builds Babylon's pipelines to match. Nothing here is read by the simulation, so this file cannot
 * affect an outcome; it is the last stage of presentation.
 *
 * ## Rebuild rather than reconfigure
 *
 * Changing tier disposes the pipeline and builds a new one. Several of Babylon's pipeline effects are fixed at construction,
 * and repeatedly toggling effects on a live pipeline leaks render targets. A tier change is a menu action, so one rebuild is
 * imperceptible, and disposal is the only way to be sure nothing is left attached to the camera.
 *
 * ## Why these settings and not stronger ones
 *
 * Bloom threshold sits ABOVE the brightness of ordinary lit geometry, so only the emissive wall strips, tracers and muzzle
 * flashes glow. A lower threshold blooms the lit faces of every box and washes the arena out, which is the usual way bloom
 * ruins a scene rather than improving it.
 *
 * SSAO strength is low and its radius small. SSAO on an axis-aligned greybox is easy to overdo: heavy occlusion in every
 * corner reads as dirt, and a large radius darkens whole walls instead of the joins between them. The radius here is tuned to
 * the 2 to 4 unit cover boxes the arena is built from.
 */

import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
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

export class PostProcessing {
  private pipeline: DefaultRenderingPipeline | null = null;
  private ssao: SSAO2RenderingPipeline | null = null;
  private currentTier: string | null = null;
  private currentLowPower = false;

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

    // Nothing enabled: skip the pipeline entirely rather than building an inert one that still costs a pass.
    const wantsPipeline = post.fxaa || post.bloom || post.toneMapping || post.msaaSamples > 0;
    if (!wantsPipeline) return;

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
       * ACES rather than the standard curve. The standard operator desaturates highlights toward white, which is exactly
       * wrong for a scene whose only bright elements are coloured emissives: an orange muzzle flash would turn cream.
       */
      ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
      ip.exposure = post.exposure;
      ip.contrast = post.contrast;
      // Vignette off: it narrows the effective field of view, which is a gameplay cost in a shooter.
      ip.vignetteEnabled = false;
    }

    // Explicitly off. All three obscure targets during combat, which is worse than looking plainer.
    pipeline.depthOfFieldEnabled = false;
    pipeline.chromaticAberrationEnabled = false;
    pipeline.grainEnabled = false;
    pipeline.sharpenEnabled = false;

    this.pipeline = pipeline;

    if (post.ssao) {
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
       * Limits how far a sample can be from the surface and still occlude it. Without a bound, a distant wall darkens the
       * floor in front of it and the arena looks grubby rather than grounded.
       */
      ssao.maxZ = 60;
      this.ssao = ssao;
    }
  }

  /**
   * Scale bloom with dynamic resolution.
   *
   * When the renderer drops resolution to hold a frame rate, bloom is the first thing worth reducing: it is the most
   * expensive remaining pass and the least necessary. Reducing it rather than disabling it avoids a visible pop mid-fight.
   */
  setLoadFactor(factor: number): void {
    if (!this.pipeline || !this.pipeline.bloomEnabled) return;
    const base = this.currentLowPower ? 0 : (this.pipeline.bloomWeight ?? 0);
    if (base === 0) return;
    this.pipeline.bloomWeight = base * Math.max(0.3, Math.min(1, factor));
  }

  dispose(): void {
    this.ssao?.dispose();
    this.ssao = null;
    this.pipeline?.dispose();
    this.pipeline = null;
  }
}
