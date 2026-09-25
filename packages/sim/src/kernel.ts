/**
 * SimulationKernel: the tick loop.
 *
 * Contract (see the Deterministic Simulation blueprint):
 * - exactly one InputFrame per tick; the tick counter is the only clock
 * - no wall clock, no frame timing, no Math.random, no IEEE transcendentals
 * - entities iterate by ascending id
 * - a checkpoint hash is emitted every HASH_INTERVAL_TICKS and at round end
 * - anything that accumulates across ticks and affects an outcome lives in SimState, never here
 */

import type { EnemyView, InputFrame, MatchConfig, RenderSnapshot, RunSummary, StateHash } from '@ra/arena-protocol';
import { HASH_INTERVAL_TICKS } from '@ra/arena-protocol';
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
import { applyAimAssist, computeAimAssist, scaleLookForAssist, type AimAssistResult } from './aim-assist.js';
import { createInitialState, type EnemyState, type PlayerState, type SimState, type Vec3Fx } from './state.js';

/**
 * Bump on any change that can alter an outcome for the same inputs. Leaderboards, daily
 * challenges and ghosts are keyed on it, and the golden replay test fails until the fixtures
 * are regenerated.
 *
 * 9 tactical enemy AI: NavGraph routes, cover, hearing, squad roles (WO-54)
 */
export const SIM_VERSION = 9;

const PITCH_LIMIT = fx.FX_QUARTER - 1;

export interface SimContent {
  hash: string;
  durationTicks: number;
  boxes: readonly BoxFx[];
  bounds: BoxFx;
  /** Player spawn points; index 0 is the round start. */
  spawns: readonly Vec3Fx[];
  spawnYaw: number;
  /** Enemy spawn points. */
  enemySpawns: readonly Vec3Fx[];
  maxHealth: number;
  weapons: readonly [string, string];
}

export interface TickEvents { combat: CombatEvent[]; enemy: EnemyEvent[]; medals: number[]; points: number; aimAssist: AimAssistResult; }
export interface Simulation { readonly config: MatchConfig; readonly content: SimContent; readonly world: CollisionWorld; readonly weaponIndices: readonly [number, number]; state: SimState; lastEvents: TickEvents; }

function emptyEvents(): TickEvents { return { combat: [], enemy: [], medals: [], points: 0, aimAssist: { targetId: 0, yawPull: 0, pitchPull: 0, slowed: false } }; }
function resolveWeapons(content: SimContent): [number, number] { return [weaponById(content.weapons[0])?.index ?? 0, weaponById(content.weapons[1])?.index ?? 2]; }
function magazines(content: SimContent) { const table = [0, 1].map((slot) => { const id = content.weapons[slot] ?? ''; const def = weaponById(id); return def ?? { magazine: 30, reserve: 120 }; }); return { magazine: [table[0]!.magazine, table[1]!.magazine], reserve: [table[0]!.reserve, table[1]!.reserve] }; }

export function createSimulation(config: MatchConfig, content: SimContent): Simulation {
  if (config.simVersion !== SIM_VERSION) throw new Error(`run is simVersion ${config.simVersion}, this build is ${SIM_VERSION}`);
  if (config.contentHash !== content.hash) throw new Error('contentHash does not match the supplied SimContent');
  const weaponIndices = resolveWeapons(content);
  const ammo = magazines(content);
  const spawn = content.spawns[0] ?? { x: 0, y: 0, z: 0 };
  return { config, content, world: createCollisionWorld(content.boxes, content.bounds), weaponIndices, state: createInitialState({ seed: config.seed >>> 0, durationTicks: content.durationTicks, spawn: { x: spawn.x, y: spawn.y, z: spawn.z }, spawnYaw: content.spawnYaw, maxHealth: content.maxHealth, magazine: ammo.magazine, reserve: ammo.reserve }), lastEvents: emptyEvents() };
}

export function restoreSimulation(config: MatchConfig, content: SimContent, bytes: Uint8Array): Simulation { if (config.contentHash !== content.hash) throw new Error('content hash does not match the supplied SimContent'); const state = deserializeState(bytes, config.simVersion); return { config, content, world: createCollisionWorld(content.boxes, content.bounds), weaponIndices: resolveWeapons(content), state, lastEvents: emptyEvents() }; }
export function serializeSimulation(sim: Simulation): Uint8Array { return serializeState(sim.state, sim.config.simVersion); }
export function hashSimulation(sim: Simulation): StateHash { return hash64(serializeSimulation(sim)); }

export function step(sim: Simulation, frame: InputFrame): void {
  const s = sim.state; if (s.ended) return; if (frame.tick !== s.tick) throw new Error(`input frame tick ${frame.tick} does not match sim tick ${s.tick}`);
  const events = emptyEvents(); events.aimAssist = applyLook(s, frame, sim.world); stepPlayerMovement(s.player as PlayerState & MovementFields, frame, sim.world); events.enemy = stepEnemies(s, sim.world); events.combat = stepWeapons(s, frame, sim.world, sim.weaponIndices);
  const clearedBefore = isWaveCleared(s); stepWaves(s, sim.content.enemySpawns); const cleared = clearedBefore && s.enemies.length > 0;
  events.points = stepScore(s, events.combat, cleared); events.medals = events.points ? medalNames(s.score) : [];
  stepRespawn(s, sim.content.spawns, sim.content.maxHealth); reapEnemies(s); sim.lastEvents = events; s.tick += 1; if (s.tick >= s.durationTicks) { s.ended = 1; applyEndOfRoundBonus(s); }
}

function applyLook(s: SimState, frame: InputFrame, world: CollisionWorld): AimAssistResult { const assist = computeAimAssist(s, frame, world); const lookYaw = scaleLookForAssist(frame.lookYaw, assist.slowed); const lookPitch = scaleLookForAssist(frame.lookPitch, assist.slowed); let yaw = (s.player.yaw + lookYaw) % fx.FX_ONE; if (yaw < 0) yaw += fx.FX_ONE; s.player.yaw = yaw | 0; s.player.pitch = fx.clamp((s.player.pitch + lookPitch) | 0, -PITCH_LIMIT, PITCH_LIMIT); applyAimAssist(s, assist, lookYaw, lookPitch); return assist; }

export function isCheckpointTick(sim: Simulation): boolean { const t = sim.state.tick; return t % HASH_INTERVAL_TICKS === 0 || sim.state.ended === 1; }
export function isEnded(sim: Simulation): boolean { return sim.state.ended === 1; }
export function snapshot(sim: Simulation): RenderSnapshot { const s = sim.state; const p = s.player; const crouching = p.crouching === 1; return { tick: s.tick, player: { id: p.id, x: fx.toFloat(p.pos.x), y: fx.toFloat((p.pos.y + eyeOffset(crouching)) | 0), z: fx.toFloat(p.pos.z), yaw: fx.toFloat(p.yaw), pitch: fx.toFloat((p.pitch + p.recoilPitch) | 0) }, playerHealth: fx.toFloat(p.health), playerDownTicks: p.downTicks, playerSliding: p.slideTicks > 0, weaponSlot: p.weaponSlot, ammo: p.ammo[p.weaponSlot] ?? 0, reserve: p.reserve[p.weaponSlot] ?? 0, enemies: s.enemies.map(enemyView), projectiles: s.projectiles.map((q) => ({ id: q.id, x: fx.toFloat(q.pos.x), y: fx.toFloat(q.pos.y), z: fx.toFloat(q.pos.z), yaw: 0, pitch: 0 })), score: s.score.score, streak: s.score.streak, multiplier: fx.toFloat(s.score.multiplier), ticksRemaining: Math.max(0, s.durationTicks - s.tick), aimAssistTargetId: sim.lastEvents.aimAssist.targetId }; }
export function enemyView(e: EnemyState): EnemyView { const def = archetypeByIndex(e.archetype); return { id: e.id, x: fx.toFloat(e.pos.x), y: fx.toFloat(e.pos.y), z: fx.toFloat(e.pos.z), yaw: fx.toFloat(e.yaw), pitch: 0, archetype: e.archetype, brain: e.brain, telegraphing: e.telegraphing === 1, healthFraction: Math.max(0, Math.min(1, fx.toFloat(e.health) / fx.toFloat(def.health || fx.FX_ONE))) }; }
export function events(sim: Simulation): TickEvents { return sim.lastEvents; }
export function playerShape(sim: Simulation) { return bodyShape(sim.state.player); }
