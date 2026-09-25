/**
 * InputRouter: turn accumulated device input into exactly one InputFrame per simulation tick.
 *
 * Three rules keep the recording honest:
 *
 *  1. One frame per tick, always. An idle tick still produces an explicit empty frame, so the tick
 *     count and the round length never depend on how fast input arrives.
 *  2. The frame sent to the worker and the frame given to the recorder are the same object. There is
 *     no path where the simulation consumes something the log did not capture.
 *  3. Devices are SUMMED, not switched between. A laptop with a touchscreen and a pad plugged in can
 *     use any of them at any moment, and a hard switch on "last device used" drops the first frame of
 *     whichever the player picks. The active scheme is tracked for HUD hints only; it never gates
 *     input.
 *
 * Gameplay input is suppressed while paused, and during the countdown only look is accepted
 * (AC-ARM-002.2).
 */

import { Buttons, emptyInputFrame, InputFlags, type InputFrame } from '@rearena/protocol';
import { FixedMath } from '@rearena/sim';
import { withSlide } from './bindings.js';
import type { GamepadAdapter } from './gamepad.js';
import type { KeyboardMouseAdapter } from './keyboard-mouse.js';
import type { TouchAdapter } from './touch.js';

export type RoundPhase = 'idle' | 'countdown' | 'playing' | 'paused' | 'ended';
export type InputScheme = 'keyboardMouse' | 'touch' | 'gamepad';

/** Seconds per simulation tick, for converting stick position into a per-tick turn. */
const TICK_SECONDS = 1 / 60;

export interface InputRouterCallbacks {
  /** Called with the frame for each tick, after it has been sent to the simulation. */
  onFrame?(frame: InputFrame): void;
  /** Called when the pause action is pressed, from any device. */
  onPausePressed?(): void;
  /** Called when the live input device changes, for HUD hints and glyphs. */
  onSchemeChange?(scheme: InputScheme): void;
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
  private scheme: InputScheme = 'keyboardMouse';
  private touch: TouchAdapter | null = null;
  private gamepad: GamepadAdapter | null = null;

  constructor(
    private readonly adapter: KeyboardMouseAdapter,
    private readonly callbacks: InputRouterCallbacks = {},
  ) {}

  /** Attach a touch adapter. Optional, so desktop pays nothing for it. */
  setTouchAdapter(touch: TouchAdapter | null): void {
    this.touch = touch;
  }

  /** Attach a gamepad adapter. Optional; it reports idle when no pad is connected. */
  setGamepadAdapter(gamepad: GamepadAdapter | null): void {
    this.gamepad = gamepad;
  }

  setPhase(phase: RoundPhase): void {
    this.phase = phase;
    // Entering a non-playing phase must not leave keys or buttons latched, or the first tick after
    // resume would fire a weapon the player is no longer holding.
    if (phase !== 'playing') {
      this.adapter.clearHeld();
      this.touch?.reset();
      this.gamepad?.clearHeld();
    }
  }

  currentPhase(): RoundPhase {
    return this.phase;
  }

  activeScheme(): InputScheme {
    return this.scheme;
  }

  private noteScheme(next: InputScheme): void {
    if (this.scheme === next) return;
    this.scheme = next;
    this.callbacks.onSchemeChange?.(next);
  }

  /**
   * Build the frame for the given tick. Always returns a frame, and always drains every device so
   * input does not pile up across a pause.
   */
  buildFrame(tick: number): InputFrame {
    const keys = this.adapter.drain();
    const touch = this.touch?.drain() ?? null;
    // The pad reports a position rather than a delta, so its look needs the tick duration.
    const pad = this.gamepad?.drain(TICK_SECONDS) ?? null;

    if (keys.pausePressed || touch?.pausePressed || pad?.pausePressed) {
      this.callbacks.onPausePressed?.();
    }

    // Note which device produced input this tick, for HUD hints and glyph selection only.
    if (pad?.active) {
      this.noteScheme('gamepad');
    } else if (touch && (touch.moveX !== 0 || touch.moveY !== 0 || touch.buttons !== 0)) {
      this.noteScheme('touch');
    } else if (keys.moveX !== 0 || keys.moveY !== 0 || keys.buttons !== 0) {
      this.noteScheme('keyboardMouse');
    }

    const frame = emptyInputFrame(tick);

    // Look is summed from every device in all live phases, including the countdown.
    const lookYaw = keys.lookYawTurns + (touch?.lookYawTurns ?? 0) + (pad?.lookYawTurns ?? 0);
    const lookPitch =
      keys.lookPitchTurns + (touch?.lookPitchTurns ?? 0) + (pad?.lookPitchTurns ?? 0);

    if (this.phase === 'countdown') {
      // Look around while waiting, but nothing else takes effect.
      frame.lookYaw = turnsToFx(lookYaw);
      frame.lookPitch = turnsToFx(lookPitch);
      return frame;
    }

    if (this.phase !== 'playing') {
      return frame;
    }

    const move = normalise(
      keys.moveX + (touch?.moveX ?? 0) + (pad?.moveX ?? 0),
      keys.moveY + (touch?.moveY ?? 0) + (pad?.moveY ?? 0),
    );
    frame.moveX = Math.round(move.x * FixedMath.FX_ONE) | 0;
    frame.moveY = Math.round(move.y * FixedMath.FX_ONE) | 0;
    frame.lookYaw = turnsToFx(lookYaw);
    frame.lookPitch = turnsToFx(lookPitch);
    // Slide is derived here, after the devices are summed. See withSlide.
    frame.buttons = withSlide(
      (keys.buttons | (touch?.buttons ?? 0) | (pad?.buttons ?? 0)) & ~Buttons.None,
    );

    /*
     * Aim assist is recorded as a flag rather than applied here. The assist itself is computed inside
     * the simulation (WO-23) so the verifier reproduces it; a client-side nudge would make the replay
     * disagree. The flag tells the simulation that this frame came from a pad and is therefore
     * eligible.
     */
    if (pad?.active && this.gamepad?.getSettings().aimAssist) {
      frame.flags |= InputFlags.AimAssist;
    }

    return frame;
  }

  /** Notify listeners that this frame was consumed by the simulation. */
  commit(frame: InputFrame): void {
    this.callbacks.onFrame?.(frame);
  }
}
