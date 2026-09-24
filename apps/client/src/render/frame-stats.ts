/**
 * FrameStats: frame time overlay.
 *
 * Reports the median and 95th percentile rather than an instantaneous value. An instantaneous frame
 * time flickers too fast to read, and a mean hides exactly the stutters worth knowing about: a run
 * at 60 fps with occasional 40 ms frames feels worse than a steady 50 fps, and only the p95 shows it.
 *
 * Off by default, per AC-PRF-003.5.
 */

import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';

/** Samples in the ring buffer. Two seconds at 60 fps. */
const WINDOW = 120;
/** Repaint every N frames. The DOM write is cheap but not free, and text changing every frame is
 * unreadable anyway. */
const REPAINT_INTERVAL = 15;

export class FrameStats {
  private readonly element: HTMLElement;
  private readonly samples = new Float32Array(WINDOW);
  private cursor = 0;
  private filled = 0;
  /**
   * Monotonic frame counter.
   *
   * Previously the repaint throttle used samples.length, which stops growing once the ring buffer is
   * full, so the overlay froze after 120 frames. A separate counter is the fix.
   */
  private frames = 0;
  private visible = false;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly label: string,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'frame-stats';
    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.style.display = visible ? 'block' : 'none';
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Called once per rendered frame, with the time since the previous rendered frame.
   *
   * The caller passes the frame time because engine.getDeltaTime() counts every animation-frame callback, including the ones the
   * frame rate cap skips. Under a cap on a high-refresh display it reported the monitor's rate, not the game's.
   */
  sample(frameMs?: number): void {
    const ms = frameMs ?? this.engine.getDeltaTime();
    this.samples[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled += 1;
    this.frames += 1;

    if (!this.visible) return;
    if (this.frames % REPAINT_INTERVAL !== 0) return;
    this.paint();
  }

  private paint(): void {
    if (this.filled === 0) return;
    const window = Array.from(this.samples.slice(0, this.filled)).sort((a, b) => a - b);
    const median = window[Math.floor(window.length / 2)] ?? 0;
    const p95 = window[Math.min(window.length - 1, Math.floor(window.length * 0.95))] ?? 0;
    const fps = median > 0 ? 1000 / median : 0;

    this.element.textContent = `${fps.toFixed(0)} fps\n${median.toFixed(1)} ms med\n${p95.toFixed(1)} ms p95\n${this.label}`;
  }

  dispose(): void {
    this.element.remove();
  }
}
