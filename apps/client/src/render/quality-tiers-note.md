/**
 * Quality tiers.
 *
 * Tiers are declared as data, not spread through conditionals at each use site. One table means what
 * a tier actually changes is readable in a single place, and adding a tier is an entry rather than a
 * hunt through the renderer.
 *
 * Everything here is presentation. No tier value reaches MatchConfig, InputFrame, or the simulation
 * worker, so AC-PRF-006.1 (quality must not change the outcome) holds by construction rather than by
 * remembering to be careful. The one thing to never add to this file is a value the simulation reads.
 */

export type QualityTierName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityTier {
  name: QualityTierName;
  label: string;
  /** Multiplier on device pixel ratio. Below 1 renders fewer pixels and upscales. */
  resolutionScale: number;
  /** Shadow map size, or 0 for no shadows. */
  shadowMapSize: number;
  shadowBlur: boolean;
  /** Camera far plane, in world units. Lower hides distant geometry behind fog. */
  drawDistance: number;
  /** Fog density. Higher hides the shortened draw distance rather than revealing a hard edge. */
  fogDensity: number;
  /** Pool sizes for tracers, impacts, decals and casings. */
  tracerPool: number;
  impactPool: number;
  decalPool: number;
  casingPool: number;
  /** Whether shell casings are ejected at all. */
  casingsEnabled: boolean;
  /** Whether corpses animate a collapse or are removed immediately. */
  deathAnimations: boolean;
  /** Whether enemy figures use the segmented rig or a simplified silhouette. */
  detailedEnemies: boolean;
  /** Loading budget in milliseconds, for AC-PRF-005.1. */
  loadingBudgetMs: number;

  // --- Post-processing ---------------------------------------------------------------------------
  //
  // Ordered by cost. Each is a full-screen pass, so the question at every tier is whether the pass buys more than the
  // fragments it spends. A device already rendering at 62% resolution is answering "no" to all of them.

  /** Fast approximate anti-aliasing. Cheapest meaningful improvement on any GPU. */
  fxaa: boolean;
  /**
   * MSAA sample count. 0 disables it.
   *
   * Separate from fxaa because they solve the same problem differently: MSAA is better on geometry edges and does nothing
   * for the emissive strips, FXAA is cheaper and smooths everything including the ones MSAA misses.
   */
  msaaSamples: number;
  /**
   * Bloom on bright pixels.
   *
   * The highest-value effect here for this arena specifically. Emissive wall strips, tracers and muzzle flashes currently
   * read as bright paint; bloom makes them read as light sources, which is most of the difference between a greybox and a
   * lit space.
   */
  bloom: boolean;
  /** Bloom strength. Restrained on purpose: heavy bloom hides enemies, which is a gameplay cost. */
  bloomWeight: number;
  /**
   * Screen-space ambient occlusion.
   *
   * The strongest remaining cue that objects rest on the floor rather than hover above it, and the most expensive thing in
   * this list: a depth prepass plus a blur. Ultra only.
   */
  ssao: boolean;
  /**
   * ACES-style tone mapping.
   *
   * Nearly free, and the single change that stops emissive surfaces clipping to flat white. Without it the wall strips and
   * muzzle flashes lose all internal detail at their centres.
   */
  toneMapping: boolean;
  /** Contrast and exposure for the grade. 1.0 is neutral. */
  contrast: number;
  exposure: number;
}

/**
 * The four tiers.
 *
 * Resolution scale is the largest lever by far, which is why it varies most: pixel count scales
 * quadratically, so 0.7 scale is roughly half the fragment work of 1.0.
 */

export const TIERS: Record<QualityTierName, QualityTier> = {
  low: {
    name: 'low',
    label: 'Low',
    resolutionScale: 0.62,
    shadowMapSize: 0,
    shadowBlur: false,
    drawDistance: 70,
    fogDensity: 0.028,
    tracerPool: 16,
    impactPool: 12,
    decalPool: 0,
    casingPool: 0,
    casingsEnabled: false,
    deathAnimations: false,
    detailedEnemies: false,
    loadingBudgetMs: 6000,
    /*
     * No post-processing at all. A device on Low is already rendering at 62% resolution to hold a frame rate, so a
     * full-screen pass is the wrong place to spend what is left. Playability first.
     */
    fxaa: false,
    msaaSamples: 0,
    bloom: false,
    bloomWeight: 0,
    ssao: false,
    toneMapping: false,
    contrast: 1,
    exposure: 1,
  },
  medium: {
    name: 'medium',
    label: 'Medium',
    resolutionScale: 0.82,
    shadowMapSize: 512,
    shadowBlur: false,
    drawDistance: 110,
    fogDensity: 0.018,
    tracerPool: 32,
    impactPool: 20,
    decalPool: 24,
    casingPool: 12,
    casingsEnabled: true,
    deathAnimations: true,
    detailedEnemies: true,
    loadingBudgetMs: 8000,
    // FXAA and tone mapping only: both are close to free, and tone mapping is what stops emissives clipping to white.
    fxaa: true,
    msaaSamples: 0,
    bloom: false,
    bloomWeight: 0,
    ssao: false,
    toneMapping: true,
    contrast: 1.04,
    exposure: 1,
  },
  high: {
    name: 'high',
    label: 'High',
    resolutionScale: 1,
    shadowMapSize: 1024,
    shadowBlur: true,
    drawDistance: 160,
    fogDensity: 0.014,
    tracerPool: 48,
    impactPool: 32,
    decalPool: 48,
    casingPool: 24,
    casingsEnabled: true,
    deathAnimations: true,
    detailedEnemies: true,
    loadingBudgetMs: 11000,
    // Bloom arrives here. SSAO waits for Ultra: a depth prepass plus a blur is far more than bloom costs.
    fxaa: true,
    msaaSamples: 2,
    bloom: true,
    bloomWeight: 0.22,
    ssao: false,
    toneMapping: true,
    contrast: 1.06,
    exposure: 1.02,
  },
  ultra: {
    name: 'ultra',
    label: 'Ultra',
    resolutionScale: 1,
    shadowMapSize: 2048,
    shadowBlur: true,
    drawDistance: 200,
    fogDensity: 0.011,
    tracerPool: 64,
    impactPool: 40,
    decalPool: 64,
    casingPool: 32,
    casingsEnabled: true,
    deathAnimations: true,
    detailedEnemies: true,
    loadingBudgetMs: 14000,
    fxaa: true,
    msaaSamples: 4,
    bloom: true,
    bloomWeight: 0.28,
    ssao: true,
    toneMapping: true,
    contrast: 1.08,
    exposure: 1.02,
  },
};

export const TIER_ORDER: readonly QualityTierName[] = ['low', 'medium', 'high', 'ultra'];

/** One step down, or null at the bottom. Used by memory pressure recovery. */
export function tierBelow(name: QualityTierName): QualityTierName | null {
  const index = TIER_ORDER.indexOf(name);
  return index > 0 ? TIER_ORDER[index - 1]! : null;
}
