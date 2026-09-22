/**
 * FrameStats: frame time sampling and an optional overlay.
 *
 * Reads the engine's own timing, never the simulation. Frame rate has no effect on gameplay
 * (AC-ARM-007.3); this exists so a slow device is visible during development and so
 * DynamicResolutionController (WO-25) and telemetry (WO-32) have a source to read.
 */

import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';

export interface FrameSample {
  fps: number;
  frameMs: number;
  /** Rolling 95th percentile frame time over the sample window. */
  p95Ms: number;
}

const WINDOW = 120;

export class FrameStats {
  private readonly samples: number[] = [];
  private cursor = 0;
  private element: HTMLElement | null = null;
  private visible = false;
  private lastPaint = 0;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly backendLabel: string,
  ) {}

  /** Call once per rendered frame. */
  sample(): void {
    const frameMs = this.engine.getDeltaTime();
    if (this.samples.length < WINDOW) {
      this.samples.push(frameMs);
    } else {
      this.samples[this.cursor] = frameMs;
      this.cursor = (this.cursor + 1) % WINDOW;
    }
    if (this.visible) this.paint(frameMs);
  }

  read(): FrameSample {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      fps: this.engine.getFps(),
      frameMs: this.samples[this.samples.length - 1] ?? 0,
      p95Ms: sorted[idx] ?? 0,
    };
  }

  /** Default off, per the Performance and Quality Tiers requirements. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.element?.remove();
      this.element = null;
      return;
    }
    if (!this.element) {
      this.element = document.createElement('div');
      this.element.className = 'frame-stats';
      this.element.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.element);
    }
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  private paint(frameMs: number): void {
    if (!this.element) return;
    // Repaint at 5 Hz: text layout every frame would itself cost frame time.
    const now = this.samples.length; // frame counter is enough for a cadence
    if (now - this.lastPaint < 12) return;
    this.lastPaint = now;
    const s = this.read();
    this.element.textContent = [
      `${s.fps.toFixed(0)} fps  ${frameMs.toFixed(1)} ms`,
      `p95 ${s.p95Ms.toFixed(1)} ms`,
      this.backendLabel,
    ].join('\n');
  }

  dispose(): void {
    this.element?.remove();
    this.element = null;
  }
}
