/**
 * WaveScheduler: when enemies arrive and what they are.
 *
 * The schedule is a pure function of the wave index, so a seed plus a tick count fully determines
 * what the player faced. Draws come only from the spawn sub-stream.
 *
 * Concurrency is capped rather than letting waves stack without limit: the cap is what keeps the
 * frame budget and the verifier replay cost predictable, and it is also better play, since forty
 * enemies converging is less interesting than eight that keep pressure on.
 */

import { archetypeByIndex } from './enemies.js';
import * as fx from './math/fixed.js';
import { nextBelow } from './math/rng.js';
import type { EnemyState, SimState, Vec3Fx } from './state.js';

/** Ticks between waves. 480 is eight seconds. */
const WAVE_INTERVAL_TICKS = 480;
/** Grace period before the first wave, so the player can orient. */
const FIRST_WAVE_TICK = 180;
/** Never more than this many alive at once. */
const MAX_CONCURRENT = 9;

export interface WavePlan {
  /** Enemy archetype indices to spawn. */
  archetypes: number[];
}

/**
 * What wave n contains. Grows in size and shifts from rushers toward heavies, so later waves ask
 * different questions rather than just more of the same.
 */
export function planWave(waveIndex: number): WavePlan {
  const size = Math.min(2 + Math.floor(waveIndex * 0.8), 7);
  const archetypes: number[] = [];
  for (let i = 0; i < size; i++) {
    if (waveIndex >= 4 && i % 4 === 3) archetypes.push(2); // heavy
    else if (waveIndex >= 2 && i % 2 === 1) archetypes.push(1); // rifleman
    else archetypes.push(0); // rusher
  }
  return { archetypes };
}

function distanceSq(a: Vec3Fx, b: Vec3Fx): number {
  const dx = fx.toFloat((a.x - b.x) | 0);
  const dz = fx.toFloat((a.z - b.z) | 0);
  return dx * dx + dz * dz;
}

/**
 * Spawn a wave if one is due. Returns the number of enemies spawned.
 *
 * Spawn points are sorted by distance from the player and the furthest are used first, so an enemy
 * never appears inside the player's immediate view. Ties are broken by a draw from the spawn
 * sub-stream, so the choice is varied but reproducible.
 */
export function stepWaves(
  state: SimState,
  spawnPoints: readonly Vec3Fx[],
  maxEnemyCount = MAX_CONCURRENT,
): number {
  const tick = state.tick;
  if (tick < FIRST_WAVE_TICK) return 0;
  const dueWave = Math.floor((tick - FIRST_WAVE_TICK) / WAVE_INTERVAL_TICKS) + 1;
  if (dueWave <= state.waveCursor) return 0;

  state.waveCursor = dueWave;
  const plan = planWave(dueWave);

  // Furthest-first ordering, computed fresh each wave because the player has moved.
  const ranked = [...spawnPoints]
    .map((p) => ({ p, d: distanceSq(p, state.player.pos) }))
    .sort((a, b) => b.d - a.d)
    .map((entry) => entry.p);

  let spawned = 0;
  for (const archetype of plan.archetypes) {
    if (state.enemies.length >= maxEnemyCount) break;
    // Pick among the furthest half, so spawns are varied without ever being close.
    const poolSize = Math.max(1, Math.ceil(ranked.length / 2));
    const choice = ranked[nextBelow(state.rngSpawn, poolSize)] ?? ranked[0]!;
    const def = archetypeByIndex(archetype);
    const enemy: EnemyState = {
      id: state.nextEntityId,
      archetype,
      pos: { x: choice.x, y: choice.y, z: choice.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0,
      health: def.health,
      brain: 0,
      brainTicks: 0,
      targetNode: 0,
      reactionTicks: def.reactionTicks,
      fireCooldownTicks: def.fireIntervalTicks,
    };
    state.nextEntityId += 1;
    // Ascending id order is an invariant of the enemy array, and appending preserves it.
    state.enemies.push(enemy);
    spawned += 1;
  }

  return spawned;
}

/** True when every enemy from the current wave is dead and the next is not yet due. */
export function isWaveCleared(state: SimState): boolean {
  return state.waveCursor > 0 && state.enemies.length === 0;
}
