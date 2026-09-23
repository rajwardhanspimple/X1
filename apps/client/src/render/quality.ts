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
  /**
   * Camera far plane, in world units.
   *
   * Not fog's job to hide. Fog separates near from far within the arena; the far plane only needs to clear the skydome, which is
   * sized from the geometry rather than from this value.
   */
  drawDistance: number;
  /**
   * Fog density.
   *
   * Tuned to the 64-unit arena, not the draw distance. The values used to scale with the far plane, so Ultra carried fog tuned for
   * a 70-unit world over an arena it did not need to hide, and distant cover greyed out for no reason. Now the gradient between
   * tiers is what the names claim: heavy enough to hide the cut on Low, only depth separation by Ultra.
   */
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

  /** Fast approximate anti-aliasing. The cheapest meaningful improvement on any GPU. */
  fxaa: boolean;
  /**
   * MSAA sample count. 0 disables it.
   *
   * Separate from fxaa because they solve the same problem differently: MSAA is better on geometry edges and does nothing
   * for emissive strips, FXAA is cheaper and smooths everything including what MSAA misses.
   */
  msaaSamples: number;
  /**
   * Bloom on bright pixels.
   *
   * The highest-value effect for this arena specifically. The emissive wall strips, tracers and muzzle flashes currently
   * read as bright paint; bloom makes them read as light sources, which is most of the difference between a greybox and a
   * lit space.
   */
  bloom: boolean;
  /** Bloom strength. Restrained on purpose: heavy bloom hides enemies, which is a gameplay cost. */
  bloomWeight: number;
  /**
   * Screen-space ambient occlusion.
   *
   * The strongest remaining cue that objects rest on the floor rather than hover above it, and by a wide margin the most
   * expensive thing in this list: a depth prepass plus a blur. Ultra only.
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
    drawDistance: 80,
    // The only tier where fog hides the cut. Heavier than the others because it has a job to do.
    fogDensity: 0.012,
    tracerPool: 16,
    impactPool: 12,
    decalPool: 0,
    casingPool: 0,
    casingsEnabled: false,
    deathAnimations: false,
    detailedEnemies: false,
    loadingBudgetMs: 6000,
    /*
     * No post-processing at all. A device on Low is already at 62% resolution to hold a frame rate, so a full-screen pass is
     * the wrong place to spend what is left. Playability first.
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
    drawDistance: 120,
    fogDensity: 0.007,
    tracerPool: 32,
    impactPool: 20,
    decalPool: 24,
    casingPool: 12,
    casingsEnabled: true,
    deathAnimations: true,
    detailedEnemies: true,
    loadingBudgetMs: 8000,
    // FXAA and tone mapping only: both near-free, and tone mapping is what stops emissives clipping to white.
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
    fogDensity: 0.004,
    tracerPool: 48,
    impactPool: 32,
    decalPool: 48,
    casingPool: 24,
    casingsEnabled: true,
    deathAnimations: true,
    detailedEnemies: true,
    loadingBudgetMs: 11000,
    // Bloom arrives here. SSAO waits for Ultra: a depth prepass plus a blur costs far more than bloom does.
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
    drawDistance: 240,
    // Light enough to be only depth separation within the arena. The skydome is sized from the geometry, so fog is not hiding a cut.
    fogDensity: 0.0028,
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

export interface QualitySettings {
  /** The tier in effect. */
  tier: QualityTierName;
  /** True when the player chose the tier, so the probe never overrides them. */
  manual: boolean;
  /** On by default, per AC-PRF-003.1. */
  dynamicResolution: boolean;
  /** Frames per second to aim for. Defaults to the device target. */
  frameRateCap: number;
  /** Extra reductions on top of the tier, set when battery saving is detected. */
  lowPowerMode: boolean;
  /** Frame rate overlay. Off by default, per AC-PRF-003.5. */
  showFrameStats: boolean;
}

const SETTINGS_KEY = 'rearena.quality.v1';

/** Desktop targets 60, mobile 30, per AC-PRF-003.2. */
export function targetFrameRate(deviceClass: string): number {
  return deviceClass === 'desktop' ? 60 : 30;
}

export function defaultSettings(deviceClass: string): QualitySettings {
  return {
    tier: 'medium',
    manual: false,
    dynamicResolution: true,
    frameRateCap: targetFrameRate(deviceClass),
    lowPowerMode: false,
    showFrameStats: false,
  };
}

/**
 * Effective post-processing for a tier, after low-power mode.
 *
 * Low-power mode strips every full-screen pass regardless of tier. Battery saving is a request to stop spending power, and a
 * post-process pass is pure power for pure appearance: it changes nothing about whether the game is playable.
 *
 * Returned as a separate object rather than mutating the tier, because TIERS is shared and a mutation would leak into every
 * later read.
 */

export function effectivePost(
  tier: QualityTier,
  lowPower: boolean,
): {
  fxaa: boolean;
  msaaSamples: number;
  bloom: boolean;
  bloomWeight: number;
  ssao: boolean;
  toneMapping: boolean;
  contrast: number;
  exposure: number;
} {
  if (lowPower) {
    return {
      fxaa: false,
      msaaSamples: 0,
      bloom: false,
      bloomWeight: 0,
      ssao: false,
      toneMapping: false,
      contrast: 1,
      exposure: 1,
    };
  }
  return {
    fxaa: tier.fxaa,
    msaaSamples: tier.msaaSamples,
    bloom: tier.bloom,
    bloomWeight: tier.bloomWeight,
    ssao: tier.ssao,
    toneMapping: tier.toneMapping,
    contrast: tier.contrast,
    exposure: tier.exposure,
  };
}

/**
 * Settings store.
 *
 * Persists to localStorage and survives a corrupt or missing value by falling back rather than
 * throwing: a bad preference must never stop the game starting.
 */

export class QualityTierStore {
  private settings: QualitySettings;
  private readonly listeners = new Set<(settings: QualitySettings) => void>();

  constructor(private readonly deviceClass: string) {
    this.settings = this.load();
  }

  private load(): QualitySettings {
    const fallback = defaultSettings(this.deviceClass);
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<QualitySettings>;
      return {
        tier: TIER_ORDER.includes(parsed.tier as QualityTierName)
          ? (parsed.tier as QualityTierName)
          : fallback.tier,
        manual: parsed.manual ?? fallback.manual,
        dynamicResolution: parsed.dynamicResolution ?? fallback.dynamicResolution,
        frameRateCap:
          typeof parsed.frameRateCap === 'number' && parsed.frameRateCap > 0
            ? parsed.frameRateCap
            : fallback.frameRateCap,
        // Low-power mode is per-session (AC-PRF-004.1), so it is never restored.
        lowPowerMode: false,
        showFrameStats: parsed.showFrameStats ?? fallback.showFrameStats,
      };
    } catch {
      return fallback;
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Storage unavailable. Settings still apply for this session.
    }
  }

  current(): QualitySettings {
    return { ...this.settings };
  }

  tier(): QualityTier {
    return TIERS[this.settings.tier];
  }

  /** Post-processing actually in effect, accounting for low-power mode. */
  post() {
    return effectivePost(this.tier(), this.settings.lowPowerMode);
  }

  /** True when the probe has not run and the player has not chosen. */
  needsProbe(): boolean {
    return !this.settings.manual && localStorage.getItem(SETTINGS_KEY) === null;
  }

  update(patch: Partial<QualitySettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.persist();
    for (const listener of this.listeners) listener(this.current());
  }

  /** Set by the probe. Does nothing if the player already chose a tier. */
  setProbed(tier: QualityTierName): void {
    if (this.settings.manual) return;
    this.update({ tier });
  }

  /** Set by the player, which locks out the probe. */

  setManual(tier: QualityTierName): void {
    this.update({ tier, manual: true });
  }

  onChange(listener: (settings: QualitySettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * QualityProbe: measure the device instead of guessing from its name.
 *
 * Reading the GPU renderer string is tempting and nearly useless: a throttled laptop and a
 * workstation report the same adapter, browsers increasingly mask the value for fingerprinting
 * reasons, and the string says nothing about sustained frame time under our own scene.
 *
 * So the probe times real frames of the real scene for a short window, then maps median frame time
 * onto a tier. Slower to decide, but it measures the thing that actually matters.
 */
export class QualityProbe {
  private samples: number[] = [];
  private running = false;
  private frames = 0;

  /** Frames to discard before measuring, so shader compilation is not counted. */
  private static readonly WARMUP_FRAMES = 12;
  /** Frames to measure. At 60 fps this is half a second, which is enough for a median. */
  private static readonly SAMPLE_FRAMES = 30;

  start(): void {
    this.samples = [];
    this.frames = 0;
    this.running = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Feed one frame's time in milliseconds. Returns a tier once enough frames are in. */
  sample(frameMs: number): QualityTierName | null {
    if (!this.running) return null;
    this.frames += 1;
    // Skip the first frames: shader compilation and texture upload make them unrepresentative.
    if (this.frames <= QualityProbe.WARMUP_FRAMES) return null;
    this.samples.push(frameMs);
    if (this.samples.length < QualityProbe.SAMPLE_FRAMES) return null;

    this.running = false;
    return this.classify();
  }

  /**
   * Median rather than mean: one long frame from a garbage collection or a browser hiccup would drag
   * a mean down a whole tier.
   */
  private classify(): QualityTierName {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;

    /*
     * Thresholds are deliberately conservative. The probe runs on the medium tier, so a device
     * comfortably inside budget there has headroom for more; one already missing budget needs less.
     * Guessing too high produces a bad first impression that the player may never come back from.
     */
    if (median <= 7) return 'ultra'; // 140+ fps of headroom
    if (median <= 12) return 'high'; // comfortably above 60
    if (median <= 22) return 'medium'; // around 45 to 60
    return 'low';
  }

  /** Called if the probe cannot finish, per AC-PRF-001.4. */
  abort(): QualityTierName {
    this.running = false;
    return 'medium';
  }
}
