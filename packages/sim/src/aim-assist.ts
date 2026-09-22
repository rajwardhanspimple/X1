/**
 * Aim assist: deterministic target magnetism for gamepad input.
 *
 * ## Why this lives in the simulation
 *
 * Aim assist changes where bullets go. If the client applied it and sent the adjusted look delta, the
 * verifier would replay the recorded inputs, compute an unassisted aim, and reject an honest gamepad run as
 * a mismatch. Worse, a modified client could claim any assist strength it liked.
 *
 * So the sim applies it, from a flag the client records in the InputFrame. The browser, ghost playback and
 * Node verification all derive the same aim from the same frame, and a replay knows whether the player had
 * assist enabled because the flag is part of the recorded input rather than a setting read at replay time.
 * This is ADR-001 of the Gamepad Support blueprint.
 *
 * ## What it does
 *
 * Two assists, both standard in console shooters, both bounded:
 *
 * **Rotational magnetism** eases aim toward the nearest visible target inside a cone. The pull is scaled by
 * how far off-centre the target is: strongest at the cone edge, zero once centred. That shape is what makes
 * assist feel like help rather than like the game taking the stick away, because it stops contributing
 * exactly when the player no longer needs it.
 *
 * **Slowdown** reduces the player's own look sensitivity while the reticle crosses a target. This is the
 * assist that actually helps tracking a moving enemy; magnetism alone helps only with acquisition.
 *
 * ## What it deliberately does not do
 *
 * No snapping, no aim-through-walls, no assist while the player is not looking at anything. Line of sight is
 * checked with the same raycast bullets use, so the two can never disagree: if a shot would hit the wall,
 * assist does not pull toward what is behind it.
 *
 * No RNG is consumed. Drawing even one value here would shift every subsequent random draw in the run and
 * invalidate existing golden replays for a purely optional feature.
 */

import { InputFlags, type InputFrame } from '@rearena/protocol';
import { raycast, type CollisionWorld } from './collision.js';
import { eyeOffset } from './movement.js';
import * as fx from './math/fixed.js';
import type { EnemyState, SimState, Vec3Fx } from './state.js';

/**
 * Assist parameters.
 *
 * Constants rather than content, because they affect outcomes: making them tunable per map would mean the
 * verifier needed the tuning data to reproduce a run, and a mismatch in that data would look like cheating.
 */

/** Half-angle of the assist cone, in turns. About 11 degrees. */
const CONE_HALF_TURNS = fx.fromRatio(3, 100);

/** Maximum distance at which assist applies. Beyond this a target is too small for it to help. */
const MAX_RANGE = fx.fromInt(45);

/**
 * Peak rotation applied per tick, in turns, at the edge of the cone.
 *
 * Small on purpose. At 60 Hz this is a little over half a degree per tick, which closes an 11-degree gap in
 * roughly a third of a second: perceptible as help, far too slow to feel like aimbotting.
 */
const MAX_PULL_TURNS = fx.fromRatio(16, 10000);

/**
 * Look sensitivity multiplier while the reticle is on a target, as a fixed-point fraction.
 *
 * 0.6 is a moderate slowdown. Lower values help tracking more but feel sticky, and sticky aim is the most
 * common complaint about assist implementations.
 */
const SLOWDOWN_SCALE = fx.fromRatio(60, 100);

/** Enemy dimensions. Must match combat.ts, or assist would aim at a box bullets do not hit. */
const ENEMY_HALF_WIDTH = fx.fromRatio(40, 100);
/** Aim at the chest rather than the feet: the centre of the hittable volume. */
const ENEMY_CHEST_HEIGHT = fx.fromRatio(120, 100);

/** Where the player's view originates. */
function eyePosition(s: SimState): Vec3Fx {
  const p = s.player;
  return {
    x: p.pos.x,
    y: (p.pos.y + eyeOffset(p.crouching === 1)) | 0,
    z: p.pos.z,
  };
}

/** Chest-height centre of an enemy, the point assist steers toward. */
function enemyAimPoint(enemy: EnemyState): Vec3Fx {
  return {
    x: enemy.pos.x,
    y: (enemy.pos.y + ENEMY_CHEST_HEIGHT) | 0,
    z: enemy.pos.z,
  };
}

/**
 * Yaw and pitch, in turns, from the eye to a point.
 *
 * Matches the convention used by movement and combat: yaw 0 looks along +Z, a quarter turn along +X.
 */
function anglesTo(from: Vec3Fx, to: Vec3Fx): { yaw: fx.Fx; pitch: fx.Fx; distance: fx.Fx } | null {
  const dx = (to.x - from.x) | 0;
  const dy = (to.y - from.y) | 0;
  const dz = (to.z - from.z) | 0;

  const flat = fx.length2(dx, dz);
  // Directly above or below: yaw is undefined, and assist has nothing useful to do.
  if (flat === 0) return null;

  const yaw = fx.atan2Turns(dx, dz);
  const pitch = fx.atan2Turns(dy, flat);
  const distance = fx.length2(flat, dy);
  return { yaw, pitch, distance };
}

/**
 * Shortest signed difference between two angles in turns.
 *
 * Wrapping matters: without it, aim at 0.99 turns and a target at 0.01 would read as nearly a full turn
 * apart and assist would drag the player the long way round.
 */
function angleDelta(from: fx.Fx, to: fx.Fx): fx.Fx {
  let delta = (to - from) | 0;
  const half = (fx.FX_ONE / 2) | 0;
  while (delta > half) delta = (delta - fx.FX_ONE) | 0;
  while (delta < -half) delta = (delta + fx.FX_ONE) | 0;
  return delta;
}

/** A target and how far off-centre it is. */
interface Candidate {
  enemy: EnemyState;
  yawDelta: fx.Fx;
  pitchDelta: fx.Fx;
  /** Angular distance from the centre of the view, in turns. */
  offCentre: fx.Fx;
  distance: fx.Fx;
}

/**
 * Best assist target, or null when nothing qualifies.
 *
 * "Best" is the most centred rather than the nearest. A distant enemy the player is already looking at is a
 * better guess at intent than a close one off to the side, and picking by proximity produces the behaviour
 * players describe as assist "grabbing" the wrong target.
 *
 * Iteration is over the enemy array in index order with ties broken by id, so the result cannot depend on
 * an accident of ordering. That matters more than it looks: a tie resolved differently in Node than in the
 * browser would desynchronise a verified run.
 */
function selectTarget(s: SimState, world: CollisionWorld): Candidate | null {
  const eye = eyePosition(s);
  const aimYaw = s.player.yaw;
  const aimPitch = s.player.pitch;

  let best: Candidate | null = null;

  for (const enemy of s.enemies) {
    if (enemy.health <= 0) continue;

    const angles = anglesTo(eye, enemyAimPoint(enemy));
    if (!angles) continue;
    if (angles.distance > MAX_RANGE) continue;

    const yawDelta = angleDelta(aimYaw, angles.yaw);
    const pitchDelta = angleDelta(aimPitch, angles.pitch);

    const absYaw = yawDelta < 0 ? (-yawDelta | 0) : yawDelta;
    const absPitch = pitchDelta < 0 ? (-pitchDelta | 0) : pitchDelta;
    if (absYaw > CONE_HALF_TURNS || absPitch > CONE_HALF_TURNS) continue;

    /*
     * Line of sight through the same raycast bullets use. Without this, assist would pull toward an enemy
     * behind cover and fight the player while every shot hit the wall.
     */
    const dir = {
      x: fx.mul(fx.sinTurns(angles.yaw), fx.cosTurns(angles.pitch)),
      y: fx.sinTurns(angles.pitch),
      z: fx.mul(fx.cosTurns(angles.yaw), fx.cosTurns(angles.pitch)),
    };
    const blocked = raycast(world, eye, dir, angles.distance);
    // A hit shorter than the target distance, allowing for the body's half width, means cover between.
    if (blocked !== null && blocked < ((angles.distance - ENEMY_HALF_WIDTH) | 0)) continue;

    const offCentre = fx.length2(absYaw, absPitch);

    if (
      best === null ||
      offCentre < best.offCentre ||
      // Deterministic tie-break, so two equally centred enemies always resolve the same way.
      (offCentre === best.offCentre && enemy.id < best.enemy.id)
    ) {
      best = { enemy, yawDelta, pitchDelta, offCentre, distance: angles.distance };
    }
  }

  return best;
}

/**
 * Scale a pull by how far off-centre the target is.
 *
 * Linear ramp: full strength at the cone edge, zero at the centre. The taper is the difference between
 * assist that helps and assist that feels like the game is aiming for you, because it withdraws precisely
 * when the player has already done the work.
 */
function pullStrength(offCentre: fx.Fx): fx.Fx {
  if (offCentre >= CONE_HALF_TURNS) return fx.FX_ONE;
  return fx.div(offCentre, CONE_HALF_TURNS);
}

/** The assist applied this tick, for tests and for the HUD to reflect. */
export interface AimAssistResult {
  /** Enemy id assist steered toward, or 0 for none. */
  targetId: number;
  /** Yaw rotation added, in turns. */
  yawPull: fx.Fx;
  pitchPull: fx.Fx;
  /** True when look sensitivity was reduced this tick. */
  slowed: boolean;
}

const NO_ASSIST: AimAssistResult = { targetId: 0, yawPull: 0, pitchPull: 0, slowed: false };

/**
 * Scale a look delta for slowdown.
 *
 * Applied to the player's own input before it rotates the view, so it reduces sensitivity rather than
 * opposing the player's motion. Opposing it would feel like drag; scaling it feels like precision.
 */
export function scaleLookForAssist(delta: fx.Fx, slowed: boolean): fx.Fx {
  return slowed ? fx.mul(delta, SLOWDOWN_SCALE) : delta;
}

/**
 * Decide this tick's assist without applying it.
 *
 * Split from application so the kernel can slow the player's look BEFORE rotating the view and apply
 * magnetism AFTER, which is the order that produces stable aim. Doing both after would let a fast stick
 * flick overshoot at full speed and then be dragged back, which reads as the aim fighting itself.
 */
export function computeAimAssist(
  s: SimState,
  frame: InputFrame,
  world: CollisionWorld,
): AimAssistResult {
  // The flag comes from the recorded frame, never from a live setting, so replays agree with play.
  if ((frame.flags & InputFlags.AimAssist) === 0) return NO_ASSIST;
  // A dead player has no aim to assist.
  if (s.player.downTicks > 0 || s.player.health <= 0) return NO_ASSIST;

  const target = selectTarget(s, world);
  if (!target) return NO_ASSIST;

  const strength = pullStrength(target.offCentre);
  const magnitude = fx.mul(MAX_PULL_TURNS, strength);

  /*
   * Pull each axis proportionally to its share of the off-centre angle, so the aim moves along the line
   * toward the target rather than yawing first and then pitching.
   */
  const yawShare = target.offCentre === 0 ? 0 : fx.div(target.yawDelta, target.offCentre);
  const pitchShare = target.offCentre === 0 ? 0 : fx.div(target.pitchDelta, target.offCentre);

  let yawPull = fx.mul(magnitude, yawShare);
  let pitchPull = fx.mul(magnitude, pitchShare);

  /*
   * Never overshoot. Without this clamp a target very near the centre could be pulled past it and oscillate,
   * which is both visible and a source of replay-sensitive jitter.
   */
  if ((target.yawDelta >= 0 && yawPull > target.yawDelta) || (target.yawDelta < 0 && yawPull < target.yawDelta)) {
    yawPull = target.yawDelta;
  }
  if (
    (target.pitchDelta >= 0 && pitchPull > target.pitchDelta) ||
    (target.pitchDelta < 0 && pitchPull < target.pitchDelta)
  ) {
    pitchPull = target.pitchDelta;
  }

  return {
    targetId: target.enemy.id,
    yawPull,
    pitchPull,
    // Slowdown applies whenever a target is in the cone, which is when tracking help is wanted.
    slowed: true,
  };
}

/** Apply the computed magnetism to the player's aim. Call after the player's own look has been applied. */
export function applyAimAssist(s: SimState, assist: AimAssistResult): void {
  if (assist.targetId === 0) return;

  let yaw = (s.player.yaw + assist.yawPull) % fx.FX_ONE;
  if (yaw < 0) yaw += fx.FX_ONE;
  s.player.yaw = yaw | 0;
  s.player.pitch = (s.player.pitch + assist.pitchPull) | 0;
}
