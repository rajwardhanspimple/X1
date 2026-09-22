/**
 * RenderInterpolator: turn 60 Hz simulation snapshots into smooth motion at display rate.
 *
 * The simulation advances in fixed steps; the display refreshes at whatever rate the device runs.
 * Drawing the newest snapshot directly makes motion step visibly on a 120 Hz screen and stutter
 * when a tick is late. Interpolating between the last two snapshots by the age of the newest one
 * fixes both.
 *
 * Continuous values (position, angle) are blended. Discrete ones (archetype, brain state, ammo,
 * score) are taken from the newest snapshot, never blended: a half-way value between two discrete
 * states is a state that never existed, and for something like a brain index it would be a
 * different state entirely.
 *
 * This is display only. Nothing computed here is ever sent back to the simulation.
 */

import type { EnemyView, PoseView, RenderSnapshot } from '@rearena/protocol';
import type { SnapshotPair } from '../worker/host.js';

const TICK_MS = 1000 / 60;

export interface InterpolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** A pose plus the discrete fields the renderer needs to choose a figure and a stance. */
export interface InterpolatedEnemy extends InterpolatedPose {
  archetype: number;
  brain: number;
  telegraphing: boolean;
  healthFraction: number;
}

/** Shortest-arc blend for values measured in turns, so crossing 1 -> 0 does not spin. */
function lerpTurns(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  let r = a + d * t;
  r %= 1;
  if (r < 0) r += 1;
  return r;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendPose(from: PoseView, to: PoseView, t: number): InterpolatedPose {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    z: lerp(from.z, to.z, t),
    yaw: lerpTurns(from.yaw, to.yaw, t),
    pitch: lerp(from.pitch, to.pitch, t),
  };
}

function blendEnemy(from: EnemyView, to: EnemyView, t: number): InterpolatedEnemy {
  const pose = blendPose(from, to, t);
  return {
    ...pose,
    // Discrete fields come from the newest snapshot only.
    archetype: to.archetype,
    brain: to.brain,
    telegraphing: to.telegraphing,
    // Health is continuous, but blending it adds nothing and costs a lerp per enemy per frame.
    healthFraction: to.healthFraction,
  };
}

/**
 * Blend factor for this frame: how far the display clock has moved past the newest snapshot, as a
 * fraction of one tick. Clamped to 1 so a late tick holds the last pose rather than extrapolating
 * into a position the simulation never produced.
 */
export function alphaFor(pair: SnapshotPair, now: number): number {
  if (!pair.previous || !pair.latest) return 1;
  const age = now - pair.latestAt;
  return Math.max(0, Math.min(1, age / TICK_MS));
}

export interface InterpolatedFrame {
  tick: number;
  player: InterpolatedPose;
  enemies: Map<number, InterpolatedEnemy>;
  projectiles: Map<number, InterpolatedPose>;
  /** The newest snapshot, for values that must not be interpolated (ammo, score, health). */
  discrete: RenderSnapshot;
}

function enemyMap(snapshot: RenderSnapshot): Map<number, EnemyView> {
  const m = new Map<number, EnemyView>();
  for (const e of snapshot.enemies) m.set(e.id, e);
  return m;
}

function poseMap(snapshot: RenderSnapshot): Map<number, PoseView> {
  const m = new Map<number, PoseView>();
  for (const p of snapshot.projectiles) m.set(p.id, p);
  return m;
}

/**
 * Interpolate the whole frame. Entities present in the newest snapshot but not the previous one
 * (they just spawned) appear at their new position without a blend, which is correct: there is no
 * earlier position to come from.
 */
export function interpolate(pair: SnapshotPair, now: number): InterpolatedFrame | null {
  const latest = pair.latest;
  if (!latest) return null;
  const previous = pair.previous;
  const t = alphaFor(pair, now);

  if (!previous) {
    return {
      tick: latest.tick,
      player: blendPose(latest.player, latest.player, 1),
      enemies: new Map(latest.enemies.map((e) => [e.id, blendEnemy(e, e, 1)])),
      projectiles: new Map(latest.projectiles.map((p) => [p.id, blendPose(p, p, 1)])),
      discrete: latest,
    };
  }

  const prevEnemies = enemyMap(previous);
  const prevProjectiles = poseMap(previous);

  const enemies = new Map<number, InterpolatedEnemy>();
  for (const e of latest.enemies) {
    const from = prevEnemies.get(e.id) ?? e;
    enemies.set(e.id, blendEnemy(from, e, t));
  }

  const projectiles = new Map<number, InterpolatedPose>();
  for (const p of latest.projectiles) {
    const from = prevProjectiles.get(p.id) ?? p;
    projectiles.set(p.id, blendPose(from, p, t));
  }

  return {
    tick: latest.tick,
    player: blendPose(previous.player, latest.player, t),
    enemies,
    projectiles,
    discrete: latest,
  };
}
