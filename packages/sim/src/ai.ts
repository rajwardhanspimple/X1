/**
 * Enemy AI.
 *
 * Two fairness rules are enforced structurally rather than by tuning, because tuning drifts:
 *
 *  1. An enemy can only fire when the line-of-sight raycast reaches the player. That is the same
 *     raycast bullets use against the same box set, so an enemy can never shoot through cover the
 *     player is hiding behind.
 *  2. An enemy cannot fire until reactionTicks have elapsed since it acquired the player, and a
 *     telegraph window precedes each shot. Both are counted in ticks, so they are identical on
 *     every device and in the verifier.
 *
 * Rule 2 was broken until WO-42's second pass: the telegraph was set AFTER the shot resolved, so the warning window ran
 * once the damage had already been dealt. It is now a genuine two-state sequence, which is what makes a heavy readable.
 *
 * Decisions draw only from the ai RNG sub-stream. Adding a random call here cannot move a player's
 * bullets in an existing run.
 */

import { isGrounded, raycast, resolveMove, type CollisionWorld } from './collision.js';
import { archetypeByIndex, Brain, type EnemyArchetype } from './enemies.js';
import { eyeOffset } from './movement.js';
import * as fx from './math/fixed.js';
import { nextChance, nextRangeFx } from './math/rng.js';
import type { EnemyState, PlayerState, SimState, Vec3Fx } from './state.js';

export interface EnemyEvent {
  kind: 'telegraph' | 'enemyShot' | 'playerHit';
  enemyId: number;
  damage?: number;
}

const ENEMY_SHAPE = { halfWidth: fx.fromRatio(40, 100), height: fx.fromRatio(180, 100) };
const ENEMY_EYE = fx.fromRatio(150, 100);
const GRAVITY = fx.fromRatio(22 * 1000, 60 * 60 * 1000) | 0;
const MAX_FALL = fx.fromRatio(45 * 1000, 60 * 1000);

/**
 * Closest an enemy may come to the player.
 *
 * The player's body half-width is 0.4 and an enemy's is 0.4, so 1.1 leaves a visible gap rather than the two touching.
 * Without this floor an enemy walks into the player's own space, the camera ends up inside its chest, and the near plane
 * clips the torso away leaving a head and shoulders filling the screen.
 *
 * A hard floor rather than a larger preferredRange: raising that would push riflemen and heavies back as well and change
 * every engagement distance in the game, when only the close case was wrong.
 */
export const MIN_PLAYER_SEPARATION = fx.fromRatio(110, 100);

/** Squared distance, avoiding a square root. Comparisons only ever need the square. */
function distanceSq(a: Vec3Fx, b: Vec3Fx): number {
  const dx = fx.toFloat((a.x - b.x) | 0);
  const dz = fx.toFloat((a.z - b.z) | 0);
  return dx * dx + dz * dz;
}

function horizontalDistance(a: Vec3Fx, b: Vec3Fx): fx.Fx {
  const dx = fx.abs((a.x - b.x) | 0);
  const dz = fx.abs((a.z - b.z) | 0);
  // Octagonal approximation: max + 0.41 * min. Within 4% of the true length, no sqrt, and exact
  // in fixed point, so it is stable across engines.
  const hi = fx.max(dx, dz);
  const lo = fx.min(dx, dz);
  return (hi + fx.mul(lo, fx.fromRatio(41, 100))) | 0;
}

/** Can this enemy see the player? The same raycast bullets use, so cover works symmetrically. */

function hasLineOfSight(
  world: CollisionWorld,
  enemy: EnemyState,
  playerEye: Vec3Fx,
  range: fx.Fx,
): boolean {
  const origin: Vec3Fx = { x: enemy.pos.x, y: (enemy.pos.y + ENEMY_EYE) | 0, z: enemy.pos.z };
  const dx = (playerEye.x - origin.x) | 0;
  const dy = (playerEye.y - origin.y) | 0;
  const dz = (playerEye.z - origin.z) | 0;
  const dist = horizontalDistance(playerEye, origin);
  if (dist > range) return false;
  if (dist === 0) return true;

  // Normalise by the approximate distance so the ray length is in the same units.
  const dir: Vec3Fx = { x: fx.div(dx, dist), y: fx.div(dy, dist), z: fx.div(dz, dist) };
  const hit = raycast(world, origin, dir, dist);
  // A hit shorter than the distance to the player means geometry is in the way.
  return hit === null || hit.distance >= (dist - fx.fromRatio(10, 100));
}

function moveToward(
  world: CollisionWorld,
  enemy: EnemyState,
  targetX: fx.Fx,
  targetZ: fx.Fx,
  speed: fx.Fx,
): void {
  const dx = (targetX - enemy.pos.x) | 0;
  const dz = (targetZ - enemy.pos.z) | 0;
  const dist = horizontalDistance({ x: targetX, y: 0, z: targetZ }, enemy.pos);
  if (dist > fx.fromRatio(5, 100)) {
    enemy.vel.x = fx.mul(fx.div(dx, dist), speed);
    enemy.vel.z = fx.mul(fx.div(dz, dist), speed);
    // Face the direction of travel.
    enemy.yaw = fx.atan2Turns(dx, dz);
  } else {
    enemy.vel.x = 0;
    enemy.vel.z = 0;
  }

  if (isGrounded(world, enemy.pos, ENEMY_SHAPE)) {
    if (enemy.vel.y < 0) enemy.vel.y = 0;
  } else {
    enemy.vel.y = fx.max((enemy.vel.y - GRAVITY) | 0, -MAX_FALL | 0);
  }

  const result = resolveMove(
    world,
    enemy.pos,
    ENEMY_SHAPE,
    { x: enemy.vel.x, y: enemy.vel.y, z: enemy.vel.z },
    true,
  );
  enemy.pos = result.pos;
  if (result.hitX) enemy.vel.x = 0;
  if (result.hitZ) enemy.vel.z = 0;
  if (result.hitY) enemy.vel.y = 0;
}

/**
 * Push an enemy out of the player's personal space.
 *
 * Applied after movement resolves rather than by refusing to move, because the AI is not the only route into an overlap:
 * collision response can slide an enemy there, and another enemy crowding from behind can shove it. A positional
 * correction catches every route to the same bad state; a movement veto catches only the one the AI took.
 *
 * Horizontal only. A vertical correction would lift an enemy off the floor or bury it, and the overlap that reads as wrong
 * on screen is horizontal anyway.
 */
function enforceSeparation(enemy: EnemyState, player: PlayerState): void {
  const dx = (enemy.pos.x - player.pos.x) | 0;
  const dz = (enemy.pos.z - player.pos.z) | 0;
  const distance = fx.length2(dx, dz);

  if (distance >= MIN_PLAYER_SEPARATION) return;

  if (distance === 0) {
    /*
     * Exactly coincident, so there is no direction to push along. Offsetting on +X is arbitrary but deterministic;
     * drawing a random direction would consume RNG and shift every later draw in the run.
     */
    enemy.pos.x = (player.pos.x + MIN_PLAYER_SEPARATION) | 0;
    enemy.vel.x = 0;
    enemy.vel.z = 0;
    return;
  }

  // Push out along the existing separation direction, so the enemy does not appear to jump sideways.
  const scale = fx.div(MIN_PLAYER_SEPARATION, distance);
  enemy.pos.x = (player.pos.x + fx.mul(dx, scale)) | 0;
  enemy.pos.z = (player.pos.z + fx.mul(dz, scale)) | 0;

  // Kill inward velocity, or the enemy grinds against the barrier every tick and visibly jitters.
  enemy.vel.x = 0;
  enemy.vel.z = 0;
}

/** Face the player without moving. */

function faceTarget(enemy: EnemyState, target: Vec3Fx): void {
  enemy.yaw = fx.atan2Turns((target.x - enemy.pos.x) | 0, (target.z - enemy.pos.z) | 0);
}

/**
 * Begin a wind-up, or fire if one has finished.
 *
 * Two states, and the order is the whole point:
 *
 *  1. Off cooldown with no wind-up in progress: set telegraphing, start the timer, emit a telegraph event, and do nothing
 *     else this tick. The renderer draws the pose, audio plays a cue, and the player has a real chance to break line of
 *     sight or take cover.
 *  2. The timer has reached zero: fire.
 *
 * This was inverted. The shot resolved first and the telegraph was set afterwards, so the warning ran after the damage and
 * a heavy's 45-tick wind-up gave no warning at all. The renderer had been drawing a telegraph pose that did not correspond
 * to anything.
 *
 * The cooldown is claimed at the SHOT, not at the wind-up. Claiming it early would add the telegraph length to every
 * firing interval, so a heavy would fire noticeably slower than its archetype declares.
 */
function tryFire(
  state: SimState,
  enemy: EnemyState,
  def: EnemyArchetype,
  distance: fx.Fx,
  events: EnemyEvent[],
): void {
  /*
   * Never engage a downed player. The damage branch below checks this too, but without this guard a shot event and a spent
   * cooldown still fired, so a downed player watched a firing squad work on a body that could not be hurt.
   */
  if (state.player.downTicks > 0) return;

  // Reaction delay has not elapsed: the enemy has seen the player but has not reacted yet.
  if (enemy.reactionTicks > 0) return;

  // A wind-up is running. decayTimers counts brainTicks down at the end of each tick.
  if (enemy.telegraphing === 1) {
    if (enemy.brainTicks > 0) return;

    // The wind-up finished, so this tick is the shot.
    enemy.telegraphing = 0;
    enemy.fireCooldownTicks = def.fireIntervalTicks;

    // Accuracy falls with distance, so backing off is a real defensive option.
    const rangeScale = fx.clamp(
      fx.div((def.sightRange - distance) | 0, def.sightRange),
      fx.fromRatio(30, 100),
      fx.FX_ONE,
    );
    const chance = fx.mul(def.accuracy, rangeScale);

    events.push({ kind: 'enemyShot', enemyId: enemy.id });

    if (nextChance(state.rngAi, chance)) {
      const p = state.player;
      if (p.downTicks === 0) {
        p.health = (p.health - def.damage) | 0;
        events.push({ kind: 'playerHit', enemyId: enemy.id, damage: fx.toInt(def.damage) });
        if (p.health <= 0) {
          p.health = 0;
          p.deaths += 1;
          p.downTicks = 180; // three seconds down before respawn
        }
      }
    }
    return;
  }

  if (enemy.fireCooldownTicks > 0) return;

  // Start the wind-up. The player sees and hears this before anything can hit them.
  enemy.telegraphing = 1;
  enemy.brainTicks = def.telegraphTicks;
  events.push({ kind: 'telegraph', enemyId: enemy.id });
}

/** Advance every enemy one tick, in ascending id order. */
export function stepEnemies(state: SimState, world: CollisionWorld): EnemyEvent[] {
  const events: EnemyEvent[] = [];
  if (state.enemies.length === 0) return events;

  const p = state.player;
  const playerEye: Vec3Fx = {
    x: p.pos.x,
    y: (p.pos.y + eyeOffset(p.crouching === 1)) | 0,
    z: p.pos.z,
  };

  
for (const enemy of state.enemies) {
    if (enemy.health <= 0) continue;
    const def = archetypeByIndex(enemy.archetype);
    const distance = horizontalDistance(playerEye, enemy.pos);
    const canSee = p.downTicks === 0 && hasLineOfSight(world, enemy, playerEye, def.sightRange);

    if (canSee) {
      // Reaction delay starts the moment the player is acquired, not the moment of the shot.
      if (enemy.brain === Brain.Idle) {
        enemy.reactionTicks = def.reactionTicks;
        enemy.brain = Brain.Advance;
      }
      if (enemy.reactionTicks > 0) {
        faceTarget(enemy, playerEye);
        // Separation applies here too: an enemy mid-reaction could otherwise walk into the camera.
        enforceSeparation(enemy, p);
        continue;
      }

      /*
       * A wind-up commits the enemy to standing still. Moving mid-telegraph would make the warning much harder to read,
       * and a heavy that charges while winding up is the exact thing the telegraph exists to prevent.
       */
      if (enemy.telegraphing === 1) {
        enemy.brain = Brain.Engage;
        enemy.vel.x = 0;
        enemy.vel.z = 0;
        moveToward(world, enemy, enemy.pos.x, enemy.pos.z, 0);
      } else if (distance > def.preferredRange) {
        enemy.brain = Brain.Advance;
        moveToward(world, enemy, p.pos.x, p.pos.z, def.speed);
      } else if (distance < fx.div(def.preferredRange, fx.fromInt(2))) {
        // Too close: back off so the player is not simply body-blocked.
        enemy.brain = Brain.Retreat;
        const awayX = (enemy.pos.x + ((enemy.pos.x - p.pos.x) | 0)) | 0;
        const awayZ = (enemy.pos.z + ((enemy.pos.z - p.pos.z) | 0)) | 0;
        moveToward(world, enemy, awayX, awayZ, def.speed);
      } else {
        enemy.brain = Brain.Engage;
        enemy.vel.x = 0;
        enemy.vel.z = 0;
        moveToward(world, enemy, enemy.pos.x, enemy.pos.z, 0);
      }

      faceTarget(enemy, playerEye);
      tryFire(state, enemy, def, distance, events);
    } else if (p.downTicks > 0) {
      /*
       * The player is down. Stand still rather than advancing on the body: the crowd would otherwise converge on the
       * corpse and be standing inside the respawn point when the player returns.
       */
      enemy.brain = Brain.Idle;
      enemy.telegraphing = 0;
      enemy.vel.x = 0;
      enemy.vel.z = 0;
      moveToward(world, enemy, enemy.pos.x, enemy.pos.z, 0);
    } else {
      /*
       * No sight. Abandon any wind-up: a telegraph the player cannot see is a shot with no warning, which is precisely
       * the unfairness this system exists to remove.
       */
      enemy.telegraphing = 0;
      if (enemy.brain !== Brain.Idle) enemy.brain = Brain.Advance;
      const jitterX = nextRangeFx(state.rngAi, -fx.fromInt(3), fx.fromInt(3));
      const jitterZ = nextRangeFx(state.rngAi, -fx.fromInt(3), fx.fromInt(3));
      moveToward(world, enemy, (p.pos.x + jitterX) | 0, (p.pos.z + jitterZ) | 0, def.speed);
    }

    // Last, so it corrects the result of whatever movement ran above.
    enforceSeparation(enemy, p);
  }

  return events;
}

/** Respawn the player when the down timer expires. */
export function stepRespawn(state: SimState, spawns: readonly Vec3Fx[], maxHealth: fx.Fx): void {
  const p = state.player;
  if (p.downTicks !== 1) return;
  // Choose the spawn point furthest from the nearest living enemy.
  let best = spawns[0]!;
  let bestScore = -1;
  for (const spawn of spawns) {
    let nearest = Number.MAX_SAFE_INTEGER;
    for (const enemy of state.enemies) {
      if (enemy.health <= 0) continue;
      nearest = Math.min(nearest, distanceSq(spawn, enemy.pos));
    }
    if (nearest > bestScore) {
      bestScore = nearest;
      best = spawn;
    }
  }
  p.pos = { x: best.x, y: best.y, z: best.z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.health = maxHealth;
  p.spreadBloom = 0;
  p.recoilPitch = 0;
}
