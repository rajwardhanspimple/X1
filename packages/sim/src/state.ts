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
 * The rule that is easiest to break and hardest to notice: ANY value that accumulates across ticks and influences a later
 * outcome must live here. A counter kept outside the state survives a single-pass replay and resets at a slice boundary,
 * so the two disagree and the verifier rejects an honest run. The headshot tally was exactly that bug, which is why
 * `score.headshots` is a field rather than something the kernel carries.
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
  /** Foot position: the bottom centre of the body box, not the eye. */
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
  /** Ticks of ledge forgiveness remaining for a jump. See movement.ts. */
  coyoteTicks: number;
  /** Ticks an early jump press is remembered while airborne. */
  jumpBufferTicks: number;
  weaponSlot: number;
  ammo: [number, number];
  reserve: [number, number];
  reloadTicks: number;
  fireCooldownTicks: number;
  /**
   * Accumulated spread from sustained fire, in turns. Part of the hashed state because it decides
   * where a bullet goes, so the verifier must see the same value the player had.
   */
  spreadBloom: Fx;
  /** Accumulated upward recoil, in turns. Also outcome-affecting, so also state. */
  recoilPitch: Fx;
  /** Whether fire was held last tick, so single-shot weapons require a release. */
  lastFireHeld: number;
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
  /**
   * 1 while a shot is being wound up, 0 otherwise.
   *
   * Separate from brainTicks because that counter serves two purposes: it times the telegraph AND gates re-entry to the
   * firing branch. Without this flag the AI cannot tell whether a non-zero brainTicks means "warning in progress" or
   * "just fired", which is what let the telegraph run after the shot instead of before it.
   */
  telegraphing: number;
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
  /**
   * Headshots this round, for the Marksman medal.
   *
   * In the state rather than in the kernel because it crosses slice boundaries. See the note at the top of this file.
   */
  headshots: number;
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
      coyoteTicks: 0,
      jumpBufferTicks: 0,
      weaponSlot: 0,
      ammo: [options.magazine[0], options.magazine[1]],
      reserve: [options.reserve[0], options.reserve[1]],
      reloadTicks: 0,
      fireCooldownTicks: 0,
      spreadBloom: 0,
      recoilPitch: 0,
      lastFireHeld: 0,
      shotsFired: 0,
      shotsHit: 0,
      kills: 0,
      deaths: 0,
    },
    enemies: [],
    projectiles: [],
    score: { score: 0, streak: 0, comboTicks: 0, multiplier: 65536, medalsMask: 0, headshots: 0 },
    waveCursor: 0,
  };
}
