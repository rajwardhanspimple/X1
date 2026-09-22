/**
 * Adaptive performance: dynamic resolution, battery saving and memory pressure.
 *
 * All three are presentation-only. They change how many pixels are drawn and which effects run,
 * never what the simulation computes, so a player on a throttled phone and one on a desktop produce
 * identical runs from identical input (AC-PRF-006.1).
 */

import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { tierBelow, type QualityTier, type QualityTierName } from './quality.js';

/**
 * DynamicResolutionController.
 *
 * Resolution is the cheapest lever available: pixel count scales quadratically, so dropping scale
 * from 1.0 to 0.8 removes about a third of the fragment work for a barely visible softening.
 *
 * Two decisions make it usable rather than distracting:
 *
 * It reacts to a rolling median, not the last frame. A single long frame from a garbage collection
 * would otherwise drop the resolution visibly for no reason.
 *
 * It lowers quickly and raises slowly. Symmetric response oscillates between two scales whenever the
 * load sits near a threshold, and a pulsing image is more irritating than sitting one step low.
 */
export class DynamicResolutionController {
  private readonly samples: number[] = [];
  private cursor = 0;
  /** Current scale as a fraction of the tier's base scale. */
  private factor = 1;
  private cooldown = 0;
  private enabled = true;

  /** Frames in the rolling window. Half a second at 60 fps. */
  private static readonly WINDOW = 30;
  /** Never go below this fraction of the tier scale; past it the image is unreadable. */
  private static readonly MIN_FACTOR = 0.6;
  private static readonly MAX_FACTOR = 1;
  /** Frames to wait after a change, so a measurement reflects the new scale. */
  private static readonly COOLDOWN_FRAMES = 24;

  constructor(
    private readonly engine: AbstractEngine,
    private basePixelRatio: number,
    private targetFrameMs: number,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Preserve the current scale rather than snapping back (AC-PRF-003.4).
      this.samples.length = 0;
    }
  }

  setTarget(frameRate: number): void {
    this.targetFrameMs = 1000 / Math.max(15, frameRate);
  }

  /** Called when the tier changes, since each tier has its own base scale. */
  setBase(pixelRatio: number, tier: QualityTier): void {
    this.basePixelRatio = pixelRatio * tier.resolutionScale;
    this.factor = 1;
    this.samples.length = 0;
    this.apply();
  }

  private apply(): void {
    const effective = this.basePixelRatio * this.factor;
    // Babylon's hardware scaling is the inverse: 1 / ratio.
    this.engine.setHardwareScalingLevel(1 / Math.max(0.25, effective));
  }

  /** Feed one frame time in milliseconds. */
  sample(frameMs: number): void {
    if (!this.enabled) return;

    if (this.samples.length < DynamicResolutionController.WINDOW) {
      this.samples.push(frameMs);
    } else {
      this.samples[this.cursor] = frameMs;
      this.cursor = (this.cursor + 1) % DynamicResolutionController.WINDOW;
    }

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    if (this.samples.length < DynamicResolutionController.WINDOW) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? this.targetFrameMs;

    // Missing budget by more than 15%: drop a step promptly.
    if (median > this.targetFrameMs * 1.15) {
      const next = Math.max(DynamicResolutionController.MIN_FACTOR, this.factor - 0.1);
      if (next !== this.factor) {
        this.factor = next;
        this.apply();
        this.cooldown = DynamicResolutionController.COOLDOWN_FRAMES;
      }
      return;
    }

    // Comfortably inside budget: climb back, but in smaller steps than the drop.
    if (median < this.targetFrameMs * 0.75) {
      const next = Math.min(DynamicResolutionController.MAX_FACTOR, this.factor + 0.04);
      if (next !== this.factor) {
        this.factor = next;
        this.apply();
        this.cooldown = DynamicResolutionController.COOLDOWN_FRAMES;
      }
    }
  }

  /** Current scale factor, for the settings display. */
  currentFactor(): number {
    return this.factor;
  }
}

/**
 * BatterySaverDetector.
 *
 * The Battery Status API is the direct signal but Safari and Firefox removed it, so it cannot be
 * relied on. Where it is missing, prefers-reduced-motion plus a mobile device class is used as a
 * proxy: a player who has asked the system to reduce motion on a phone is usually also conserving
 * power, and the worst case of a false positive is a slightly lower tier.
 */
export class BatterySaverDetector {
  private saving = false;
  private readonly listeners = new Set<(saving: boolean) => void>();

  constructor(private readonly deviceClass: string) {
    void this.detect();
  }

  private async detect(): Promise<void> {
    // Non-standard but widely shipped on Chromium; typed locally rather than polluting globals.
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        charging: boolean;
        level: number;
        addEventListener(type: string, listener: () => void): void;
      }>;
    };

    if (nav.getBattery) {
      try {
        const battery = await nav.getBattery();
        const evaluate = () => {
          // Under 20% and not charging is the usual point at which a phone throttles itself.
          this.set(!battery.charging && battery.level <= 0.2);
        };
        battery.addEventListener('levelchange', evaluate);
        battery.addEventListener('chargingchange', evaluate);
        evaluate();
        return;
      } catch {
        // Fall through to the proxy.
      }
    }

    if (this.deviceClass !== 'desktop' && typeof matchMedia === 'function') {
      const query = matchMedia('(prefers-reduced-motion: reduce)');
      const evaluate = () => this.set(query.matches);
      query.addEventListener('change', evaluate);
      evaluate();
    }
  }

  private set(saving: boolean): void {
    if (this.saving === saving) return;
    this.saving = saving;
    for (const listener of this.listeners) listener(saving);
  }

  isSaving(): boolean {
    return this.saving;
  }

  onChange(listener: (saving: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface MemoryPressureCallbacks {
  /** Reduce to this tier and tell the player why (AC-PRF-004.3, AC-PRF-004.4). */
  onReduce(tier: QualityTierName, reason: string): void;
  /** Already at the lowest tier and still under pressure (AC-PRF-004.5). */
  onExhausted(message: string): void;
}

/**
 * MemoryPressureHandler.
 *
 * There is no cross-browser memory pressure event. Chrome exposes performance.memory; elsewhere a
 * sustained collapse in frame rate is used as a proxy, because a browser close to its heap limit
 * spends most of its time collecting garbage and that is visible as frame time long before a crash.
 *
 * Reducing a tier and saying so is strictly better than an out-of-memory tab crash the player cannot
 * interpret.
 */
export class MemoryPressureHandler {
  private consecutiveSlowFrames = 0;
  private lastActionAt = 0;

  /** Frames above four times budget before treating it as pressure rather than a hitch. */
  private static readonly SLOW_FRAME_LIMIT = 90;
  /** Minimum gap between reductions, so one bad patch does not walk down every tier. */
  private static readonly ACTION_COOLDOWN_MS = 12000;

  constructor(private readonly callbacks: MemoryPressureCallbacks) {}

  /** Called each frame with the current tier and frame time. */
  sample(currentTier: QualityTierName, frameMs: number, targetFrameMs: number, now: number): void {
    if (now - this.lastActionAt < MemoryPressureHandler.ACTION_COOLDOWN_MS) return;

    if (this.heapCritical()) {
      this.reduce(currentTier, 'Memory is running low', now);
      return;
    }

    // Four times budget sustained is not a hitch, it is a device in trouble.
    if (frameMs > targetFrameMs * 4) {
      this.consecutiveSlowFrames += 1;
    } else {
      this.consecutiveSlowFrames = 0;
    }

    if (this.consecutiveSlowFrames >= MemoryPressureHandler.SLOW_FRAME_LIMIT) {
      this.consecutiveSlowFrames = 0;
      this.reduce(currentTier, 'The device is struggling to keep up', now);
    }
  }

  /** Chrome only. Absent elsewhere, which is why the frame-time proxy exists. */
  private heapCritical(): boolean {
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    };
    const memory = perf.memory;
    if (!memory || memory.jsHeapSizeLimit <= 0) return false;
    return memory.usedJSHeapSize / memory.jsHeapSizeLimit > 0.92;
  }

  private reduce(currentTier: QualityTierName, reason: string, now: number): void {
    this.lastActionAt = now;
    const next = tierBelow(currentTier);
    if (next) {
      this.callbacks.onReduce(next, `${reason}. Quality reduced to keep the round playable.`);
    } else {
      this.callbacks.onExhausted(
        `${reason}, and quality is already at its lowest. Close other tabs, then reload to continue.`,
      );
    }
  }
}
