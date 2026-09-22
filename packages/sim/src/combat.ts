/**
 * Combat: firing, spread, recoil, reload, hitscan and damage.
 *
 * Everything here is deterministic. Spread is drawn only from the spread RNG sub-stream, so a
 * future change to enemy AI (which draws from the ai sub-stream) cannot move a bullet in an
 * already-recorded run. Recoil is state, not a visual effect, so the server applies exactly the
 * same aim offset the player had.
 */

import { Buttons, type InputFrame } from '@rearena/protocol';
import { raycast, type CollisionWorld } from './collision.js';
import { eyeOffset } from './movement.js';
import * as fx from './math/fixed.js';
import { nextRangeFx } from './math/rng.js';
import type { EnemyState, SimState, Vec3Fx } from './state.js';
import { damageAtDistance, weaponByIndex, type WeaponDef } from './weapons.js';

/** Events produced this tick, for the renderer and the score engine. Never part of the hash. */
export interface CombatEvent {
  kind: 'shot' | 'hit' | 'headshot' | 'kill' | 'reloadStart' | 'reloadEnd' | 'swap' | 'dryFire';
  /** Enemy id for hit and kill events. */
  targetId?: number;
  /** World point of a hit, for impact effects. */
  point?: Vec3Fx;
  weaponIndex?: number;
}

/** Enemy hitbox dimensions. Head is the top slice; everything else is body. */
const ENEMY_HALF_WIDTH = fx.fromRatio(40, 100);
const ENEMY_HEIGHT = fx.fromRatio(180, 100);
const ENEMY_HEAD_FROM = fx.fromRatio(148, 100);

/** Where the shot originates, relative to the player's foot position. */
function eyePosition(state: SimState): Vec3Fx {
  const p = state.player;
  return {
    x: p.pos.x,
    y: (p.pos.y + eyeOffset(p.crouching === 1)) | 0,
    z: p.pos.z,
  };
}

/**
 * Unit direction from yaw and pitch, both in turns.
 *
 * Matches the renderer's convention: yaw 0 looks along +Z, a quarter turn looks along +X.
 */
function aimDirection(yaw: fx.Fx, pitch: fx.Fx): Vec3Fx {
  const cosPitch = fx.cosTurns(pitch);
  return {
    x: fx.mul(fx.sinTurns(yaw), cosPitch),
    y: fx.sinTurns(pitch),
    z: fx.mul(fx.cosTurns(yaw), cosPitch),
  };
}

function currentSpread(state: SimState, def: WeaponDef, aiming: boolean): fx.Fx {
  const base = aiming ? def.spreadAds : def.spreadHip;
  return (base + state.player.spreadBloom) | 0;
}

/**
 * Enemy hit test along a ray.
 *
 * A box test rather than a capsule: enemies are upright boxes, the maths is exact in fixed point,
 * and at these dimensions the difference is not perceptible. Returns the nearest enemy hit.
 */
function hitEnemy(
  enemies: readonly EnemyState[],
  origin: Vec3Fx,
  dir: Vec3Fx,
  maxDistance: fx.Fx,
): { enemy: EnemyState; distance: fx.Fx; point: Vec3Fx; head: boolean } | null {
  let best: { enemy: EnemyState; distance: fx.Fx; point: Vec3Fx; head: boolean } | null = null;

  for (const enemy of enemies) {
    if (enemy.health <= 0) continue;
    const minX = (enemy.pos.x - ENEMY_HALF_WIDTH) | 0;
    const maxX = (enemy.pos.x + ENEMY_HALF_WIDTH) | 0;
    const minY = enemy.pos.y;
    const maxY = (enemy.pos.y + ENEMY_HEIGHT) | 0;
    const minZ = (enemy.pos.z - ENEMY_HALF_WIDTH) | 0;
    const maxZ = (enemy.pos.z + ENEMY_HALF_WIDTH) | 0;

    let tMin: fx.Fx = 0;
    let tMax: fx.Fx = maxDistance;
    let miss = false;

    for (let axis = 0; axis < 3 && !miss; axis++) {
      const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
      const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
      const lo = axis === 0 ? minX : axis === 1 ? minY : minZ;
      const hi = axis === 0 ? maxX : axis === 1 ? maxY : maxZ;
      if (d === 0) {
        if (o < lo || o > hi) miss = true;
        continue;
      }
      let t1 = fx.div((lo - o) | 0, d);
      let t2 = fx.div((hi - o) | 0, d);
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) miss = true;
    }

    if (miss || tMin < 0) continue;
    if (best !== null && tMin >= best.distance) continue;

    const point: Vec3Fx = {
      x: (origin.x + fx.mul(dir.x, tMin)) | 0,
      y: (origin.y + fx.mul(dir.y, tMin)) | 0,
      z: (origin.z + fx.mul(dir.z, tMin)) | 0,
    };
    const head = ((point.y - enemy.pos.y) | 0) >= ENEMY_HEAD_FROM;
    best = { enemy, distance: tMin, point, head };
  }

  return best;
}

/** Fire one shot (or one pellet). Mutates state and appends events. */
function fireShot(
  state: SimState,
  world: CollisionWorld,
  def: WeaponDef,
  aiming: boolean,
  events: CombatEvent[],
): void {
  const p = state.player;
  const origin = eyePosition(state);
  const spread = currentSpread(state, def, aiming);

  for (let pellet = 0; pellet < def.pellets; pellet++) {
    // Spread is a square offset in yaw and pitch. Cheap, unbiased enough for gameplay, and it
    // needs no trigonometry beyond what aimDirection already does.
    const offsetYaw = spread === 0 ? 0 : nextRangeFx(state.rngSpread, -spread, spread);
    const offsetPitch = spread === 0 ? 0 : nextRangeFx(state.rngSpread, -spread, spread);
    const dir = aimDirection(
      (p.yaw + offsetYaw) | 0,
      fx.clamp((p.pitch + p.recoilPitch + offsetPitch) | 0, -fx.FX_QUARTER + 1, fx.FX_QUARTER - 1),
    );

    const enemyHit = hitEnemy(state.enemies, origin, dir, def.range);
    const levelHit = raycast(world, origin, dir, def.range);

    // Whichever is nearer wins, so cover blocks bullets.
    if (enemyHit && (!levelHit || enemyHit.distance <= levelHit.distance)) {
      const raw = damageAtDistance(def, enemyHit.distance);
      const damage = enemyHit.head ? fx.mul(raw, def.headshotMultiplier) : raw;
      enemyHit.enemy.health = (enemyHit.enemy.health - damage) | 0;
      p.shotsHit += 1;
      events.push({
        kind: enemyHit.head ? 'headshot' : 'hit',
        targetId: enemyHit.enemy.id,
        point: enemyHit.point,
      });
      if (enemyHit.enemy.health <= 0) {
        enemyHit.enemy.health = 0;
        p.kills += 1;
        events.push({ kind: 'kill', targetId: enemyHit.enemy.id, point: enemyHit.point });
      }
    } else if (levelHit) {
      events.push({ kind: 'hit', point: levelHit.point });
    }
  }

  p.shotsFired += 1;
  p.ammo[p.weaponSlot] = Math.max(0, (p.ammo[p.weaponSlot] ?? 0) - 1);
  p.fireCooldownTicks = def.fireIntervalTicks;
  p.spreadBloom = fx.min((p.spreadBloom + def.spreadPerShot) | 0, def.spreadMax);
  p.recoilPitch = (p.recoilPitch + def.recoilPitch) | 0;
  events.push({ kind: 'shot', weaponIndex: def.index });
}

function beginReload(state: SimState, def: WeaponDef, events: CombatEvent[]): void {
  const p = state.player;
  const slot = p.weaponSlot;
  if (p.reloadTicks > 0) return;
  if ((p.reserve[slot] ?? 0) <= 0) return;
  if ((p.ammo[slot] ?? 0) >= def.magazine) return;
  p.reloadTicks = def.reloadTicks;
  events.push({ kind: 'reloadStart', weaponIndex: def.index });
}

function finishReload(state: SimState, def: WeaponDef, events: CombatEvent[]): void {
  const p = state.player;
  const slot = p.weaponSlot;
  const missing = def.magazine - (p.ammo[slot] ?? 0);
  const taken = Math.min(missing, p.reserve[slot] ?? 0);
  p.ammo[slot] = (p.ammo[slot] ?? 0) + taken;
  p.reserve[slot] = (p.reserve[slot] ?? 0) - taken;
  events.push({ kind: 'reloadEnd', weaponIndex: def.index });
}

/**
 * Advance weapons one tick. Runs after movement so a shot uses the position the player ended the
 * tick at, which is what the renderer will show.
 */
export function stepWeapons(
  state: SimState,
  frame: InputFrame,
  world: CollisionWorld,
  weaponIndices: readonly [number, number],
): CombatEvent[] {
  const events: CombatEvent[] = [];
  const p = state.player;

  // Down players cannot act, but their timers still run so they recover on schedule.
  if (p.downTicks > 0) {
    p.lastFireHeld = 0;
    return events;
  }

  const def = weaponByIndex(weaponIndices[p.weaponSlot] ?? 0);
  const firing = (frame.buttons & Buttons.Fire) !== 0;
  const aiming = (frame.buttons & Buttons.Aim) !== 0;

  // Reload completion is checked before new input, so a reload that finishes this tick allows a
  // shot on the same tick rather than one tick later.
  if (p.reloadTicks === 1) finishReload(state, def, events);

  if ((frame.buttons & Buttons.Swap) !== 0 && p.reloadTicks === 0) {
    p.weaponSlot = p.weaponSlot === 0 ? 1 : 0;
    p.spreadBloom = 0;
    p.fireCooldownTicks = Math.max(p.fireCooldownTicks, 18); // swap takes 0.3 s
    events.push({ kind: 'swap', weaponIndex: weaponIndices[p.weaponSlot] ?? 0 });
    p.lastFireHeld = firing ? 1 : 0;
    return events;
  }

  if ((frame.buttons & Buttons.Reload) !== 0) {
    beginReload(state, def, events);
  }

  const canFire =
    firing &&
    p.reloadTicks === 0 &&
    p.fireCooldownTicks === 0 &&
    (def.automatic || p.lastFireHeld === 0);

  if (canFire) {
    if ((p.ammo[p.weaponSlot] ?? 0) > 0) {
      fireShot(state, world, def, aiming, events);
    } else {
      events.push({ kind: 'dryFire', weaponIndex: def.index });
      // Empty and the player is holding the trigger: start a reload rather than making them press R.
      beginReload(state, def, events);
      p.fireCooldownTicks = 12;
    }
  }

  // Spread and recoil decay toward zero whenever a shot was not fired this tick.
  if (!canFire) {
    p.spreadBloom = fx.max(0, (p.spreadBloom - def.spreadRecovery) | 0);
    if (p.recoilPitch > 0) {
      p.recoilPitch = fx.max(0, (p.recoilPitch - def.recoilRecovery) | 0);
    }
  }

  p.lastFireHeld = firing ? 1 : 0;
  return events;
}

/** Remove dead enemies. Called after combat so events still reference them by id. */
export function reapEnemies(state: SimState): void {
  if (state.enemies.length === 0) return;
  state.enemies = state.enemies.filter((e) => e.health > 0);
}
