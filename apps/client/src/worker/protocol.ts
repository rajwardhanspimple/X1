/**
 * Message contract between the main thread and the simulation worker.
 *
 * Versioned with SIM_VERSION: a browser holding a stale worker script after a deploy must fail
 * loudly rather than produce a run that the verifier will reject for reasons nobody can explain.
 *
 * Only plain data crosses the boundary. Nothing here carries a function, a Babylon object, or a
 * DOM node, which is why visual events use plain number triples rather than Vector3.
 *
 * Note what is NOT here: no command writes gameplay state. The main thread can send input and
 * lifecycle commands and nothing else. Health, ammo, score and position are only ever read, through
 * snapshots. That is the boundary that makes a run verifiable, and the `debug` command below is the
 * one deliberate exception, which is why it taints the run.
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

/** 8: snapshots carry the frames the worker consumed, so the run log records exactly what ran. */
export const WORKER_PROTOCOL_VERSION = 8;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Developer overrides for playtesting.
 *
 * Every one of these makes the run unverifiable, because the worker applies them after the
 * simulation has already stepped. A clean replay of the same inputs would produce different state,
 * so the checkpoint hashes diverge and the verifier rejects the run. The client marks it tainted
 * rather than discovering that server-side.
 */
export interface DebugFlags {
  /** Health is restored to full after every tick. */
  invincible: boolean;
  /** The magazine is refilled after every tick. */
  infiniteAmmo: boolean;
}

export const NO_DEBUG: DebugFlags = { invincible: false, infiniteAmmo: false };

/** One-shot developer actions, as distinct from persistent flags. */
export type DebugAction =
  /** Remove every living enemy. */
  | { kind: 'clearWave' }
  /** Jump the wave counter forward, to reach late-game pressure quickly. */
  | { kind: 'setWave'; wave: number }
  /** End the round now, so the results screen can be reached without waiting three minutes. */
  | { kind: 'endRound' };

export type VisualEvent =
  | { kind: 'tracer'; from: Point3; to: Point3 }
  | { kind: 'impact'; at: Point3; onBody: boolean }
  | { kind: 'muzzle'; weaponIndex: number }
  /** id lets the renderer flash the right figure's muzzle, so the player can see who fired. */
  | { kind: 'enemyShot'; id: number; at: Point3 }
  | { kind: 'enemyDeath'; id: number; at: Point3 }
  | { kind: 'enemyHit'; id: number }
  /**
   * `at` is where the attacker stood, so the HUD can light the edge of the screen the shot came
   * from rather than the whole frame. Optional: without it the cue degrades to a veil rather than
   * disappearing, which is the right trade for an event that exists to warn.
   */
  | { kind: 'playerHurt'; at?: Point3 }
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
  /** Queue input for a tick. The worker consumes the frame whose tick matches, or an empty frame. */
  | { type: 'input'; frame: InputFrame }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'dispose' }
  /** Developer overrides. Taints the run permanently. */
  | { type: 'debug'; flags?: Partial<DebugFlags>; action?: DebugAction };

export type WorkerEvent =
  | { type: 'ready'; protocolVersion: number; simVersion: number }
  | {
      type: 'snapshot';
      snapshot: RenderSnapshot;
      /**
       * The frames the simulation actually consumed since the last snapshot, in tick order, including
       * the empty frames it substituted for ticks with no input queued. The run log records these rather
       * than the frames the main thread sent, so it always matches what ran and a replay steps through
       * identical inputs.
       */
      consumed: InputFrame[];
      /** HUD events accumulated across the ticks in this batch. */
      hudEvents: HudEvent[];
      /** Visual and audio events for this batch. */
      visualEvents: VisualEvent[];
      /** Current weapon spread as a fraction of its maximum, for the crosshair. */
      spread: number;
      /** Horizontal speed in units per second, for sway and bob. */
      speed: number;
      /** How far through a reload the player is, 0 to 1, or 0 when not reloading. */
      reloadProgress: number;
      /** True while aiming down sights. */
      aiming: boolean;
      /** True while the player is on the ground, for bob and landing detection. */
      grounded: boolean;
      /** True once a developer override has been used. The run can no longer be submitted. */
      tainted: boolean;
    }
  | { type: 'checkpoint'; checkpoint: StateCheckpoint }
  /** `tainted` is repeated here because the summary is what a submission would carry. */
  | { type: 'ended'; summary: RunSummary; tainted: boolean }
  | { type: 'error'; message: string };

export class WorkerProtocolError extends Error {}
