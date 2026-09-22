/**
 * SimState: every value that affects the outcome of a round.
 *
 * Rules this shape must keep (see the Deterministic Simulation blueprint):
 * - No closures, class instances with behaviour, engine handles, or host objects. The state has
 *   to survive serialize -> restore with an identical hash, because the verifier replays a run
 *   in slices across separate Edge Function invocations.
 * - Entity arrays stay sorted by ascending id. Iteration order is part of the outcome.
 * - Every number is an integer: a tick count, a Q16.16 fixed-point value, or a plain count.
 *
 * Gameplay systems that read and write these fields arrive later: movement and collision in
 * WO-36, weapons and damage in WO-39, enemies and waves in WO-42, scoring and medals in WO-45.
 * This file defines the shape so the kernel, the hasher and the replay path can be built and
 * tested first.
 */

import type { Fx } from './math/fixed.js';
import { createRng, RngStream, type RngState } from './math/rng.js';

export interface Vec3Fx {
  x: Fx;
  y: Fx;
  z: Fx;
}

export interface PlayerState {
  id: number;
  pos: Vec3Fx;
  vel: Vec3Fx;
  /** Facing, in turns. */
  yaw: Fx;
  /** Pitch in turns, clamped to +/- a quarter turn. */
  pitch: Fx;
  health: Fx;
  /** Ticks remaining in the Player Down state; 0 when alive. */
  downTicks: number;
  crouching: number;
  grounded: number;
  weaponSlot: number;
  ammo: [number, number];
  reserve: [number, number];
  reloadTicks: number;
  fireCooldownTicks: number;
  shotsFired: number;
  shotsHit: number;
  kills: number;
  deaths: number;
}

export interface EnemyState {
  id: number;
  archetype: number;
  pos: Vec3Fx;
  vel: Vec3Fx;
  yaw: Fx;
  health: Fx;
  /** State machine index: idle, advance, engage, cover, flank, retreat. */
  brain: number;
  brainTicks: number;
  targetNode: number;
  reactionTicks: number;
  fireCooldownTicks: number;
}

export interface ProjectileState {
  id: number;
  ownerId: number;
  weapon: number;
  pos: Vec3Fx;
  vel: Vec3Fx;
  lifeTicks: number;
}

export interface ScoreState {
  score: number;
  streak: number;
  comboTicks: number;
  multiplier: Fx;
  /** Bitmask of medal ids awarded this round. */
  medalsMask: number;
}

export interface SimState {
  tick: number;
  /** Round length in ticks, from ModeRules. */
  durationTicks: number;
  ended: number;
  rngSpawn: RngState;
  rngSpread: RngState;
  rngAi: RngState;
  rngMisc: RngState;
  nextEntityId: number;
  player: PlayerState;
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  score: ScoreState;
  waveCursor: number;
}

export function vec3(x: Fx = 0, y: Fx = 0, z: Fx = 0): Vec3Fx {
  return { x, y, z };
}

export interface InitialStateOptions {
  seed: number;
  durationTicks: number;
  spawn: Vec3Fx;
  spawnYaw: Fx;
  maxHealth: Fx;
  magazine: [number, number];
  reserve: [number, number];
}

export function createInitialState(options: InitialStateOptions): SimState {
  return {
    tick: 0,
    durationTicks: options.durationTicks,
    ended: 0,
    rngSpawn: createRng(options.seed, RngStream.Spawn),
    rngSpread: createRng(options.seed, RngStream.Spread),
    rngAi: createRng(options.seed, RngStream.Ai),
    rngMisc: createRng(options.seed, RngStream.Misc),
    nextEntityId: 2,
    player: {
      id: 1,
      pos: { ...options.spawn },
      vel: vec3(),
      yaw: options.spawnYaw,
      pitch: 0,
      health: options.maxHealth,
      downTicks: 0,
      crouching: 0,
      grounded: 1,
      weaponSlot: 0,
      ammo: [options.magazine[0], options.magazine[1]],
      reserve: [options.reserve[0], options.reserve[1]],
      reloadTicks: 0,
      fireCooldownTicks: 0,
      shotsFired: 0,
      shotsHit: 0,
      kills: 0,
      deaths: 0,
    },
    enemies: [],
    projectiles: [],
    score: { score: 0, streak: 0, comboTicks: 0, multiplier: 65536, medalsMask: 0 },
    waveCursor: 0,
  };
}
