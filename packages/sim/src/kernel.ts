/**
 * SimulationKernel: the tick loop.
 *
 * Contract (see the Deterministic Simulation blueprint):
 * - exactly one InputFrame per tick; the tick counter is the only clock
 * - no wall clock, no frame timing, no Math.random, no IEEE transcendentals
 * - entities iterate by ascending id
 * - a checkpoint hash is emitted every HASH_INTERVAL_TICKS and at round end
 *
 * System order inside a tick is fixed and part of the outcome:
 *   look -> player movement -> enemy decisions -> enemy movement -> weapons and projectiles
 *   -> damage -> wave scheduler -> scoring -> end check
 * Movement is in (WO-36). Weapons and damage are WO-39, enemies and waves WO-42, scoring WO-45.
 */

import type {
  InputFrame,
  MatchConfig,
  RenderSnapshot,
  RunSummary,
  StateHash,
} from '@rearena/protocol';
import { HASH_INTERVAL_TICKS } from '@rearena/protocol';
import { hash64 } from './hash/xxhash32.js';
import * as fx from './math/fixed.js';
import { createCollisionWorld, type BoxFx, type CollisionWorld } from './collision.js';
import { bodyShape, eyeOffset, stepPlayerMovement, type MovementFields } from './movement.js';
import { deserializeState, serializeState } from './serialize.js';
import {
  createInitialState,
  type EnemyState,
  type PlayerState,
  type ProjectileState,
  type SimState,
} from './state.js';

/**
 * Bump on any change that can alter an outcome for the same inputs. Leaderboards, daily
 * challenges and ghosts are keyed on it, and the golden replay test fails until the fixtures
 * are regenerated.
 *
 * 2: player movement and collision (WO-36); state format 2.
 */
export const SIM_VERSION = 2;

/** Pitch is clamped to just under a quarter turn so the camera cannot flip over. */
const PITCH_LIMIT = fx.FX_QUARTER - 1;

/**
 * Gameplay data the kernel needs. Produced by the content pipeline and validated by
 * @rearena/content-schema. Widened as each gameplay system lands.
 */
export interface SimContent {
  hash: string;
  durationTicks: number;
  /** Solid boxes, in stable order. The renderer draws the same set. */
  boxes: readonly BoxFx[];
  bounds: BoxFx;
  spawn: { x: number; y: number; z: number };
  spawnYaw: number;
  maxHealth: number;
  magazine: [number, number];
  reserve: [number, number];
}

export interface Simulation {
  readonly config: MatchConfig;
  readonly content: SimContent;
  /** Built once from content; derived data, never serialised. */
  readonly world: CollisionWorld;
  state: SimState;
}

type MovingPlayer = PlayerState & MovementFields;

function buildWorld(content: SimContent): CollisionWorld {
  return createCollisionWorld(content.boxes, content.bounds);
}

export function createSimulation(config: MatchConfig, content: SimContent): Simulation {
  if (config.simVersion !== SIM_VERSION) {
    throw new Error(`run is simVersion ${config.simVersion}, this build is ${SIM_VERSION}`);
  }
  if (config.contentHash !== content.hash) {
    throw new Error('contentHash does not match the supplied SimContent');
  }
  return {
    config,
    content,
    world: buildWorld(content),
    state: createInitialState({
      seed: config.seed >>> 0,
      durationTicks: content.durationTicks,
      spawn: { x: content.spawn.x, y: content.spawn.y, z: content.spawn.z },
      spawnYaw: content.spawnYaw,
      maxHealth: content.maxHealth,
      magazine: content.magazine,
      reserve: content.reserve,
    }),
  };
}

/** Restore a simulation mid-round from canonical state bytes. Used by slice replay. */
export function restoreSimulation(
  config: MatchConfig,
  content: SimContent,
  bytes: Uint8Array,
): Simulation {
  if (config.contentHash !== content.hash) {
    throw new Error('contentHash does not match the supplied SimContent');
  }
  return {
    config,
    content,
    world: buildWorld(content),
    state: deserializeState(bytes, config.simVersion),
  };
}

export function serializeSimulation(sim: Simulation): Uint8Array {
  return serializeState(sim.state, sim.config.simVersion);
}

/** Hash of the full gameplay state. Identical bytes give an identical hash on every engine. */
export function hashSimulation(sim: Simulation): StateHash {
  return hash64(serializeSimulation(sim));
}

/**
 * Advance exactly one tick.
 *
 * The frame's tick must equal the current tick: the caller never skips or merges frames, and a
 * mismatch means the log is malformed rather than the player being idle.
 */
export function step(sim: Simulation, frame: InputFrame): void {
  const s = sim.state;
  if (s.ended) return;
  if (frame.tick !== s.tick) {
    throw new Error(`input frame tick ${frame.tick} does not match sim tick ${s.tick}`);
  }

  applyLook(s, frame);
  stepSystems(sim, frame);

  s.tick += 1;
  if (s.tick >= s.durationTicks) s.ended = 1;
}

/** Look deltas arrive already scaled by sensitivity, so the log stays device independent. */
function applyLook(s: SimState, frame: InputFrame): void {
  let yaw = (s.player.yaw + frame.lookYaw) % fx.FX_ONE;
  if (yaw < 0) yaw += fx.FX_ONE;
  s.player.yaw = yaw | 0;
  s.player.pitch = fx.clamp((s.player.pitch + frame.lookPitch) | 0, -PITCH_LIMIT, PITCH_LIMIT);
}

/** Fixed system order. Each stage lands with its own work order. */
function stepSystems(sim: Simulation, frame: InputFrame): void {
  const s = sim.state;

  stepPlayerMovement(s.player as MovingPlayer, frame, sim.world);

  // WO-42 EnemyBrain decisions, then enemy movement
  // WO-39 WeaponSystem (fire, reload, projectiles), then DamageModel
  // WO-42 WaveScheduler
  // WO-45 ScoreEngine

  if (s.player.reloadTicks > 0) s.player.reloadTicks -= 1;
  if (s.player.fireCooldownTicks > 0) s.player.fireCooldownTicks -= 1;
  if (s.player.downTicks > 0) s.player.downTicks -= 1;
  if (s.score.comboTicks > 0) s.score.comboTicks -= 1;

  for (const e of s.enemies) {
    if (e.reactionTicks > 0) e.reactionTicks -= 1;
    if (e.fireCooldownTicks > 0) e.fireCooldownTicks -= 1;
    if (e.brainTicks > 0) e.brainTicks -= 1;
  }

  advanceProjectiles(s);
}

/** Straight-line integration and lifetime. Collision against the level lands with WO-39. */
function advanceProjectiles(s: SimState): void {
  if (s.projectiles.length === 0) return;
  const alive: ProjectileState[] = [];
  for (const q of s.projectiles) {
    q.pos.x = (q.pos.x + q.vel.x) | 0;
    q.pos.y = (q.pos.y + q.vel.y) | 0;
    q.pos.z = (q.pos.z + q.vel.z) | 0;
    if (q.lifeTicks > 1) {
      q.lifeTicks -= 1;
      alive.push(q);
    }
  }
  s.projectiles = alive;
}

/** True when this tick boundary is a checkpoint. Call after step(). */
export function isCheckpointTick(sim: Simulation): boolean {
  const t = sim.state.tick;
  return t % HASH_INTERVAL_TICKS === 0 || sim.state.ended === 1;
}

export function isEnded(sim: Simulation): boolean {
  return sim.state.ended === 1;
}

/** Render-facing view. Floats here only; nothing read back into the sim. */
export function snapshot(sim: Simulation): RenderSnapshot {
  const s = sim.state;
  const p = s.player;
  const crouching = p.crouching === 1;
  return {
    tick: s.tick,
    player: {
      id: p.id,
      x: fx.toFloat(p.pos.x),
      // Report the eye, not the foot: the camera consumes this directly.
      y: fx.toFloat((p.pos.y + eyeOffset(crouching)) | 0),
      z: fx.toFloat(p.pos.z),
      yaw: fx.toFloat(p.yaw),
      pitch: fx.toFloat(p.pitch),
    },
    playerHealth: fx.toFloat(p.health),
    playerDownTicks: p.downTicks,
    weaponSlot: p.weaponSlot,
    ammo: p.ammo[p.weaponSlot] ?? 0,
    reserve: p.reserve[p.weaponSlot] ?? 0,
    enemies: s.enemies.map(enemyView),
    projectiles: s.projectiles.map((q) => ({
      id: q.id,
      x: fx.toFloat(q.pos.x),
      y: fx.toFloat(q.pos.y),
      z: fx.toFloat(q.pos.z),
      yaw: 0,
      pitch: 0,
    })),
    score: s.score.score,
    streak: s.score.streak,
    multiplier: fx.toFloat(s.score.multiplier),
    ticksRemaining: Math.max(0, s.durationTicks - s.tick),
  };
}

function enemyView(e: EnemyState) {
  return {
    id: e.id,
    x: fx.toFloat(e.pos.x),
    y: fx.toFloat(e.pos.y),
    z: fx.toFloat(e.pos.z),
    yaw: fx.toFloat(e.yaw),
    pitch: 0,
  };
}

/** Body dimensions for the current stance, for the renderer and for hit tests. */
export function playerShape(sim: Simulation) {
  return bodyShape(sim.state.player.crouching === 1);
}

/** Final result of a round. Accuracy is basis points so it hashes and compares exactly. */
export function summary(sim: Simulation, medals: string[] = []): RunSummary {
  const p = sim.state.player;
  const accuracyBp = p.shotsFired === 0 ? 0 : Math.floor((p.shotsHit * 10000) / p.shotsFired);
  return {
    score: sim.state.score.score,
    kills: p.kills,
    deaths: p.deaths,
    accuracyBp,
    shotsFired: p.shotsFired,
    shotsHit: p.shotsHit,
    medals,
    durationTicks: sim.state.tick,
    finalHash: hashSimulation(sim),
  };
}
