/**
 * LookPredictor: show mouse look now, not one simulation round trip later.
 *
 * The simulation owns aim, because aim decides where bullets go and the verifier has to replay it. But waiting for the simulation
 * to report aim before moving the view costs a full round trip: the pump drains the mouse, the worker runs the tick, the snapshot
 * comes back, and the renderer blends toward it. That is 30 to 50 ms, and it reads as heavy, floaty aim.
 *
 * So the camera starts from the newest snapshot's aim and adds every look delta the simulation has not applied yet: frames already
 * sent to the worker but not run, plus movement the adapter has not drained. For mouse input this matches what the simulation will
 * compute, because the simulation adds the same deltas. Where it differs (gamepad aim-assist slowdown, recoil between snapshots) the
 * next snapshot corrects it within a tick.
 *
 * Presentation only. Nothing here reaches the simulation, the run log, or a bullet (Core Gunplay ADR-001).
 */

import type { InputFrame } from '@rearena/protocol';
import { FixedMath } from '@rearena/sim';

/** The simulation clamps pitch just inside a quarter turn, so the view must not predict past it. */
const PITCH_LIMIT = 0.25;

interface PendingLook {
  tick: number;
  yaw: number;
  pitch: number;
}

export interface PredictedAim {
  yaw: number;
  pitch: number;
}

export class LookPredictor {
  /** Look sent to the worker and not yet reflected in a snapshot, in tick order. */
  private readonly pending: PendingLook[] = [];

  /** A frame was sent to the worker. Frames arrive in tick order, one per tick. */
  record(frame: InputFrame): void {
    if (frame.lookYaw === 0 && frame.lookPitch === 0) return;
    this.pending.push({
      tick: frame.tick,
      yaw: FixedMath.toFloat(frame.lookYaw),
      pitch: FixedMath.toFloat(frame.lookPitch),
    });
  }

  /**
   * Aim to draw this frame.
   *
   * `latestTick` is the newest snapshot's tick, which is the next tick the worker will run, so every frame below it is already
   * included in `baseYaw` and `basePitch`. `unsentYaw` and `unsentPitch` are the movement the adapter holds but has not drained.
   */
  predict(
    latestTick: number,
    baseYaw: number,
    basePitch: number,
    unsentYaw: number,
    unsentPitch: number,
  ): PredictedAim {
    let applied = 0;
    while (applied < this.pending.length && this.pending[applied]!.tick < latestTick) applied += 1;
    if (applied > 0) this.pending.splice(0, applied);

    let yaw = baseYaw + unsentYaw;
    let pitch = basePitch + unsentPitch;
    for (const look of this.pending) {
      yaw += look.yaw;
      pitch += look.pitch;
    }

    yaw %= 1;
    if (yaw < 0) yaw += 1;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    return { yaw, pitch };
  }

  /** Forget pending look. Called when a round starts, pauses or ends, because the worker drops its queue then. */
  reset(): void {
    this.pending.length = 0;
  }
}
