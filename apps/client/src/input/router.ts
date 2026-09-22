/**
 * InputRouter: turn accumulated device input into exactly one InputFrame per simulation tick.
 *
 * Two rules keep the recording honest:
 *  1. One frame per tick, always. An idle tick still produces an explicit empty frame, so the tick
 *     count and the round length never depend on how fast input arrives.
 *  2. The frame sent to the worker and the frame given to the recorder are the same object. There
 *     is no path where the simulation consumes something the log did not capture.
 *
 * Gameplay input is suppressed while paused, and during the countdown only look is accepted
 * (AC-ARM-002.2).
 */

import { Buttons, emptyInputFrame, type InputFrame } from '@rearena/protocol';
import { FixedMath } from '@rearena/sim';
import type { KeyboardMouseAdapter } from './keyboard-mouse.js';

export type RoundPhase = 'idle' | 'countdown' | 'playing' | 'paused' | 'ended';

export interface InputRouterCallbacks {
  /** Called with the frame for each tick, after it has been sent to the simulation. */
  onFrame?(frame: InputFrame): void;
  /** Called when the pause action is pressed. */
  onPausePressed?(): void;
}

/** Movement axes are clamped to a unit circle so diagonals are not faster than cardinals. */
function normalise(x: number, y: number): { x: number; y: number } {
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const length = Math.sqrt(x * x + y * y);
  if (length <= 1) return { x, y };
  return { x: x / length, y: y / length };
}

/** Float turns to Q16.16. Rounding here is the last floating-point step before the simulation. */
function turnsToFx(turns: number): number {
  return Math.round(turns * FixedMath.FX_ONE) | 0;
}

export class InputRouter {
  private phase: RoundPhase = 'idle';

  constructor(
    private readonly adapter: KeyboardMouseAdapter,
    private readonly callbacks: InputRouterCallbacks = {},
  ) {}

  setPhase(phase: RoundPhase): void {
    this.phase = phase;
    // Entering a non-playing phase must not leave keys latched, or the first tick after resume
    // would fire a weapon the player is no longer holding.
    if (phase !== 'playing') this.adapter.clearHeld();
  }

  currentPhase(): RoundPhase {
    return this.phase;
  }

  /**
   * Build the frame for the given tick. Always returns a frame, and always drains the adapter so
   * input does not pile up across a pause.
   */
  buildFrame(tick: number): InputFrame {
    const raw = this.adapter.drain();

    if (raw.pausePressed) this.callbacks.onPausePressed?.();

    const frame = emptyInputFrame(tick);

    if (this.phase === 'countdown') {
      // Look around while waiting, but nothing else takes effect.
      frame.lookYaw = turnsToFx(raw.lookYawTurns);
      frame.lookPitch = turnsToFx(raw.lookPitchTurns);
      return frame;
    }

    if (this.phase !== 'playing') {
      return frame;
    }

    const move = normalise(raw.moveX, raw.moveY);
    frame.moveX = Math.round(move.x * FixedMath.FX_ONE) | 0;
    frame.moveY = Math.round(move.y * FixedMath.FX_ONE) | 0;
    frame.lookYaw = turnsToFx(raw.lookYawTurns);
    frame.lookPitch = turnsToFx(raw.lookPitchTurns);
    frame.buttons = raw.buttons & ~Buttons.None;
    return frame;
  }

  /** Notify listeners that this frame was consumed by the simulation. */
  commit(frame: InputFrame): void {
    this.callbacks.onFrame?.(frame);
  }
}
