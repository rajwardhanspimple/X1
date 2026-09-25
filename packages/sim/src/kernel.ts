/**
 * SimulationKernel: the tick loop.
 *
 * Contract (see the Deterministic Simulation blueprint):
 * - exactly one InputFrame per tick; the tick counter is the only clock
 * - no wall clock, no frame timing, no Math.random, no IEEE transcendentals
 * - entities iterate by ascending id
 * - a checkpoint hash is emitted every HASH_INTERVAL_TICKS and at round end
 * - anything that accumulates across ticks and affects an outcome lives in SimState, never here
 *
 * That last rule is newer than the others and was added after a real defect: the headshot tally used to be a mutable box
 * owned by this file, so a sliced replay restored it as zero and could miss a medal a single-pass replay awarded. Slice
 * equivalence is the property the whole verifier rests on, and any counter kept outside the state quietly breaks it.
 *
 * The system order below is part of the outcome. It is fixed deliberately:
 *   1 look        the player aims before anything reads their facing
 *   2 movement    position settles before bullets and sight lines are computed
 *   3 enemies     AI reacts to where the player actually ended up
 *   4 weapons     the player shoots from their final position this tick
 *   5 waves       new arrivals cannot be shot on the tick they spawn
 *   6 score       kills from this tick are counted before the round can end
 *   7 respawn     a down timer that expires this tick puts the player back
 *   8 reap        dead enemies leave after events have referenced them
 */

import type {
  EnemyView,
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
import { reapEnemies, stepWeapons, type CombatEvent } from './combat.js';
import { stepEnemies, stepRespawn, type EnemyEvent } from './ai.js';
import { archetypeByIndex } from './enemies.js';
import { isWaveCleared, stepWaves } from './waves.js';
import { applyEndOfRoundBonus, medalNames, stepScore } from './score.js';
import { weaponById } from './weapons.js';
import { deserializeState, serializeState } from './serialize.js';
import {
  applyAimAssist,
  computeAimAssist,
  scaleLookForAssist,
  type AimAssistResult,
} from './aim-assist.js';
import {
  createInitialState,
  type EnemyState,
  type PlayerState,
  type SimState,
  type Vec3Fx,
} from './state.js';

/**
 * Bump on any change that can alter an outcome for the same inputs. Leaderboards, daily
 * challenges and ghosts are keyed on it, and the golden replay test fails until the fixtures
 * are regenerated.
 *
 * 1 initial. 2 movement and collision (WO-36). 3 weapons, enemies, waves, score (WO-39/42/45).
 * 4 gamepad aim assist (WO-23): a frame carrying the AimAssist flag now changes the resulting aim.
 * 5 enemy separation and no firing at a downed player (WO-42): positions and shot timing differ.
 * 6 serialised headshot tally and telegraphing flag, and the telegraph now precedes the shot
 *   (WO-45, WO-42): shot timing shifts by the telegraph length on every engagement.
 * 7 player spawns moved off the perimeter container rows (layout.ts): every run starts somewhere else.
 * 8 slide (Buttons.Slide, player.slideTicks): a sprinting player can slide (WO-56).
 * 9 tactical enemy AI: NavGraph routes, cover, hearing, squad roles (WO-54).
 */
export const SIM_VERSION = 9;

const PITCH_LIMIT = fx.FX_QUARTER - 1;

export interface SimContent {
  hash: string;
  durationTicks: number;
  /** Solid boxes, in stable order. The renderer draws the same set. */
  boxes: readonly BoxFx[];
  bounds: BoxFx;
  /** Player spawn points; index 0 is the round start. */
  spawns: readonly Vec3Fx[];
  spawnYaw: number;
  /** Enemy spawn points. */
  enemySpawns: readonly Vec3Fx[];
  maxHealth: number;
  /** Weapon ids for the primary and secondary slots. */
  weapons: readonly [string, string];
}

/** Events for the renderer this tick. Never hashed, never read back by the simulation. */
export interface TickEvents {
  combat: CombatEvent[];
  enemy: EnemyEvent[];
  medals: number[];
  points: number;
  /** Assist applied this tick. Presentation and tests only. */
  aimAssist: AimAssistResult;
}

export interface Simulation {
  readonly config: MatchConfig;
  readonly content: SimContent;
  /** Built once from content; derived data, never serialised. */
  readonly world: CollisionWorld;
  /** Weapon table indices for the two slots, resolved from content at construction. */
  readonly weaponIndices: readonly [number, number];
  state: SimState;
  lastEvents: TickEvents;
}

function emptyEvents(): TickEvents {
  return {
    combat: [],
    enemy: [],
    medals: [],
    points: 0,
    aimAssist: { targetId: 0, yawPull: 0, pitchPull: 0, slowed: false },
  };
}

function resolveWeapons(content: SimContent): [number, number] {
  const primary = weaponById(content.weapons[0])?.index ?? 0;
  const secondary = weaponById(content.weapons[1])?.index ?? 2;
  return [primary, secondary];
}

function magazines(content: SimContent): {
  magazine: [number, number];
  reserve: [number, number];
} {
  const table = [0, 1].map((slot) => {
    const id = content.weapons[slot] ?? '';
    const def = weaponById(id);
    return def ?? { magazine: 30, reserve: 120 };
  });
  return {
    magazine: [table[0]!.magazine, table[1]!.magazine],
    reserve: [table[0]!.reserve, table[1]!.reserve],
  };
}

export function createSimulation(config: MatchConfig, content: SimContent): Simulation {
  if (config.simVersion !== SIM_VERSION) {
    throw new Error(`run is simVersion ${config.simVersion}, this build is ${SIM_VERSION}`);
  }
  if (config.contentHash !== content.hash) {
    throw new Error('contentHash does not match the supplied SimContent');
  }
  const weaponIndices = resolveWeapons(content);
  const ammo = magazines(content);
  const spawn = content.spawns[0] ?? { x: 0, y: 0, z: 0 };
  return {
    config,
    content,
    world: createCollisionWorld(content.boxes, content.bounds),
    weaponIndices,
    state: createInitialState({
      seed: config.seed >>> 0,
      durationTicks: content.durationTicks,
      spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
      spawnYaw: content.spawnYaw,
      maxHealth: content.maxHealth,
      magazine: ammo.magazine,
      reserve: ammo.reserve,
    }),
    lastEvents: emptyEvents(),
  };
}

/**
 * Restore a simulation mid-round from canonical state bytes. Used by slice replay.
 *
 * Note what is NOT reconstructed here: nothing. Every value the simulation reads comes from the deserialized state, which
 * is what makes a resumed replay identical to a single-pass one. This function used to reset a headshot counter it owned,
 * and that one line was enough to make the verifier reject honest runs.
 */
export function restoreSimulation(
  config: MatchConfig,
  content: SimContent,
  bytes: Uint8Array,
): Simulation {
  if (config.contentHash !== content.hash) {
    throw new Error('contentHash does not match the supplied SimContent');
  }
  const state = deserializeState(bytes, config.simVersion);
  return {
    config,
    content,
    world: createCollisionWorld(content.boxes, content.bounds),
    weaponIndices: resolveWeapons(content),
    state,
    lastEvents: emptyEvents(),
  };
}

export function serializeSimulation(sim: Simulation): Uint8Array {
  return serializeState(sim.state, sim.config.simVersion);
}

export function hashSimulation(sim: Simulation): StateHash {
  return hash64(serializeSimulation(sim));
}

/** Advance exactly one tick. */
export function step(sim: Simulation, frame: InputFrame): void {
  const s = sim.state;
  if (s.ended) return;
  if (frame.tick !== s.tick) {
    throw new Error(`input frame tick ${frame.tick} does not match sim tick ${s.tick}`);
  }

  const events = emptyEvents();

  events.aimAssist = applyLook(s, frame, sim.world);
  stepPlayerMovement(s.player as PlayerState & MovementFields, frame, sim.world);
  events.enemy = stepEnemies(s, sim.world);
  events.combat = stepWeapons(s, frame, sim.world, sim.weaponIndices);

  const clearedBefore = isWaveCleared(s);
  stepWaves(s, sim.content.enemySpawns);
  const cleared = clearedBefore && s.enemies.length > 0;

  const scored = stepScore(s, events.combat, cleared);
  events.medals = scored.medals;
  events.points = scored.points;

  stepRespawn(s, sim.content.spawns, sim.content.maxHealth);
  decayTimers(s);
  reapEnemies(s);

  sim.lastEvents = events;

  s.tick += 1;
  if (s.tick >= s.durationTicks) {
    s.ended = 1;
    applyEndOfRoundBonus(s);
  }
}

/**
 * Apply the player's look, with gamepad aim assist when the recorded frame asks for it.
 *
 * The order here is deliberate and is the whole of WO-23:
 *
 *  1. Assist is computed against the aim as it stands at the START of the tick. Selecting a target after the player's own
 *     look would make assist chase its own correction from the previous tick, which oscillates.
 *  2. Slowdown scales the player's own delta BEFORE it rotates the view. Scaling the input reduces sensitivity, which
 *     feels like precision; subtracting from an already-applied rotation would feel like drag.
 *  3. Magnetism is applied AFTER. Applying it first would let a fast flick overshoot at full speed and then be dragged
 *     back, which reads as the aim fighting the player.
 *
 * With no AimAssist flag this reduces exactly to the previous behaviour: the multiplier is 1 and the pull is zero.
 */
function applyLook(s: SimState, frame: InputFrame, world: CollisionWorld): AimAssistResult {
  const assist = computeAimAssist(s, frame, world);

  const lookYaw = scaleLookForAssist(frame.lookYaw, assist.slowed);
  const lookPitch = scaleLookForAssist(frame.lookPitch, assist.slowed);

  let yaw = (s.player.yaw + lookYaw) % fx.FX_ONE;
  if (yaw < 0) yaw += fx.FX_ONE;
  s.player.yaw = yaw | 0;
  s.player.pitch = fx.clamp((s.player.pitch + lookPitch) | 0, -PITCH_LIMIT, PITCH_LIMIT);

  applyAimAssist(s, assist);
  // Clamp again: magnetism can push pitch past the limit when a target is sharply above or below.
  s.player.pitch = fx.clamp(s.player.pitch, -PITCH_LIMIT, PITCH_LIMIT);

  return assist;
}

/** Countdowns run last, so a timer set this tick is not immediately decremented. */
function decayTimers(s: SimState): void {
  const p = s.player;
  if (p.reloadTicks > 0) p.reloadTicks -= 1;
  if (p.fireCooldownTicks > 0) p.fireCooldownTicks -= 1;
  if (p.downTicks > 0) p.downTicks -= 1;
  if (s.score.comboTicks > 0) s.score.comboTicks -= 1;
  for (const e of s.enemies) {
    if (e.reactionTicks > 0) e.reactionTicks -= 1;
    if (e.fireCooldownTicks > 0) e.fireCooldownTicks -= 1;
    if (e.brainTicks > 0) e.brainTicks -= 1;
  }
}

export function isCheckpointTick(sim: Simulation): boolean {
  const t = sim.state.tick;
  return t % HASH_INTERVAL_TICKS === 0 || sim.state.ended === 1;
}

export function isEnded(sim: Simulation): boolean {
  return sim.state.ended === 1;
}

export function snapshot(sim: Simulation): RenderSnapshot {
  const s = sim.state;
  const p = s.player;
  const crouching = p.crouching === 1;
  return {
    tick: s.tick,
    player: {
      id: p.id,
      x: fx.toFloat(p.pos.x),
      // The eye, not the foot: the camera consumes this directly.
      y: fx.toFloat((p.pos.y + eyeOffset(crouching)) | 0),
      z: fx.toFloat(p.pos.z),
      yaw: fx.toFloat(p.yaw),
      // Recoil is part of aim, so the camera must show it.
      pitch: fx.toFloat((p.pitch + p.recoilPitch) | 0),
    },
    playerHealth: fx.toFloat(p.health),
    playerDownTicks: p.downTicks,
    playerSliding: p.slideTicks > 0,
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
    /*
     * Which enemy assist is holding, so the HUD can mark it. Derived from the tick's assist result rather than recomputed,
     * because a second computation could disagree with the one that moved the aim.
     */
    aimAssistTargetId: sim.lastEvents.aimAssist.targetId,
  };
}

/**
 * Render-facing view of one enemy.
 *
 * Archetype and brain state are reported rather than left for the client to guess: the client was
 * deriving archetype from entity id, which drew rushers with a heavy's size and colour.
 */
function enemyView(e: EnemyState): EnemyView {
  const def = archetypeByIndex(e.archetype);
  const maxHealth = def.health > 0 ? def.health : fx.FX_ONE;
  return {
    id: e.id,
    x: fx.toFloat(e.pos.x),
    y: fx.toFloat(e.pos.y),
    z: fx.toFloat(e.pos.z),
    yaw: fx.toFloat(e.yaw),
    pitch: 0,
    archetype: e.archetype,
    brain: e.brain,
    // Read straight from the flag now, rather than inferred from brainTicks. The inference was wrong in both directions:
    // it reported a telegraph during a post-shot cooldown and missed one during the wind-up.
    telegraphing: e.telegraphing === 1,
    healthFraction: Math.max(0, Math.min(1, fx.toFloat(e.health) / fx.toFloat(maxHealth))),
  };
}

/** Events produced by the most recent tick, for the renderer. */
export function events(sim: Simulation): TickEvents {
  return sim.lastEvents;
}

export function playerShape(sim: Simulation) {
  return bodyShape(sim.state.player.crouching === 1);
}

export function summary(sim: Simulation): RunSummary {
  const p = sim.state.player;
  const accuracyBp = p.shotsFired === 0 ? 0 : Math.floor((p.shotsHit * 10000) / p.shotsFired);
  return {
    score: sim.state.score.score,
    kills: p.kills,
    deaths: p.deaths,
    accuracyBp,
    shotsFired: p.shotsFired,
    shotsHit: p.shotsHit,
    medals: medalNames(sim.state.score.medalsMask),
    durationTicks: sim.state.tick,
    finalHash: hashSimulation(sim),
  };
}
