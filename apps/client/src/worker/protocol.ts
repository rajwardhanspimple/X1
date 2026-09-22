/**
 * Message contract between the main thread and the simulation worker.
 *
 * Versioned with SIM_VERSION: a browser holding a stale worker script after a deploy must fail
 * loudly rather than produce a run that the verifier will reject for reasons nobody can explain.
 *
 * Only plain data crosses the boundary. Nothing here carries a function, a Babylon object, or a
 * DOM node, which is why visual events use plain number triples rather than Vector3.
 */

import type {
  InputFrame,
  MatchConfig,
  RenderSnapshot,
  RunSummary,
  StateCheckpoint,
} from '@rearena/protocol';
import type { SimContent } from '@rearena/sim';
import type { HudEvent } from '../hud/hud.js';

export const WORKER_PROTOCOL_VERSION = 6;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Visual and audio events for the client: the exact rays, impact points and positions the
 * simulation produced.
 *
 * These come from the simulation rather than being recomputed on the client, because recomputing
 * would duplicate the spread and recoil maths and the copy would eventually disagree with what the
 * verifier replays.
 */
export type VisualEvent =
  | { kind: 'tracer'; from: Point3; to: Point3 }
  | { kind: 'impact'; at: Point3; onBody: boolean }
  | { kind: 'muzzle'; weaponIndex: number }
  /** id lets the renderer flash the right figure's muzzle, so the player can see who fired. */
  | { kind: 'enemyShot'; id: number; at: Point3 }
  | { kind: 'enemyDeath'; id: number; at: Point3 }
  | { kind: 'enemyHit'; id: number }
  | { kind: 'playerHurt' }
  | { kind: 'reloadStart' }
  | { kind: 'dryFire' }
  | { kind: 'kill' }
  | { kind: 'headshot' }
  | { kind: 'medal' }
  | { kind: 'waveStart' };

export type WorkerCommand =
  | {
      type: 'init';
      protocolVersion: number;
      config: MatchConfig;
      content: SimContent;
      /** Ticks of simulation the worker may catch up in one wake-up. Guards against stalls. */
      maxCatchUpTicks?: number;
    }
  /** Queue input for the next tick. One frame is consumed per tick, in arrival order. */
  | { type: 'input'; frame: InputFrame }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'dispose' };

export type WorkerEvent =
  | { type: 'ready'; protocolVersion: number; simVersion: number }
  | {
      type: 'snapshot';
      snapshot: RenderSnapshot;
      /** HUD events accumulated across the ticks in this batch. */
      hudEvents: HudEvent[];
      /** Visual and audio events for this batch. */
      visualEvents: VisualEvent[];
      /** Current weapon spread as a fraction of its maximum, for the crosshair. */
      spread: number;
      /** Horizontal speed in units per second, for sway and bob. */
      speed: number;
      /**
       * How far through a reload the player is, 0 to 1, or 0 when not reloading.
       *
       * A boolean cannot drive a staged animation: the stages would have to assume a duration, and
       * a rifle takes 2.1 s while a pistol takes 1.4 s, so one of them would desync. Reporting the
       * fraction lets the animation fill exactly the time the simulation takes.
       */
      reloadProgress: number;
      /** True while aiming down sights. */
      aiming: boolean;
      /** True while the player is on the ground, for bob and landing detection. */
      grounded: boolean;
    }
  | { type: 'checkpoint'; checkpoint: StateCheckpoint }
  | { type: 'ended'; summary: RunSummary }
  | { type: 'error'; message: string };

export class WorkerProtocolError extends Error {}
