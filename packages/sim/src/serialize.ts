/**
 * Canonical serialisation of SimState.
 *
 * The byte layout is the single source of truth for both hashing and slice resumption:
 * the StateHash is a hash of these bytes, so restore(serialize(s)) provably hashes the same as s.
 * Fields are written in a fixed order, little-endian, with no padding and no keys, so object key
 * order in the engine cannot leak into the outcome.
 *
 * Adding a field to SimState means adding it here and bumping STATE_FORMAT_VERSION. That changes
 * every hash, so it also requires a SIM_VERSION bump; the golden replay test fails until both
 * are done, which is the intended guard.
 */

import type { RngState } from './math/rng.js';
import type {
  EnemyState,
  PlayerState,
  ProjectileState,
  SimState,
  Vec3Fx,
} from './state.js';

export const STATE_FORMAT_VERSION = 1;

/** 'RASS': RE:Arena Sim State. */
const MAGIC = 0x52415353;

const PLAYER_BYTES = 4 + 24 + 24 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 8 + 8 + 4 + 4 + 4 + 4 + 4 + 4;
const ENEMY_BYTES = 4 + 4 + 24 + 24 + 4 + 4 + 4 + 4 + 4 + 4 + 4;
const PROJECTILE_BYTES = 4 + 4 + 4 + 24 + 24 + 4;
const HEADER_BYTES = 4 + 2 + 4 + 4 + 4 + 4 + 16 * 4;
const SCORE_BYTES = 4 + 4 + 4 + 4 + 4;
const COUNT_BYTES = 2;

class Writer {
  private readonly view: DataView;
  private offset = 0;
  readonly bytes: Uint8Array;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(v: number): void {
    this.view.setUint16(this.offset, v & 0xffff, true);
    this.offset += 2;
  }

  i32(v: number): void {
    this.view.setInt32(this.offset, v | 0, true);
    this.offset += 4;
  }

  u32(v: number): void {
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }

  vec(v: Vec3Fx): void {
    this.i32(v.x);
    this.i32(v.y);
    this.i32(v.z);
  }

  rng(s: RngState): void {
    this.u32(s[0]);
    this.u32(s[1]);
    this.u32(s[2]);
    this.u32(s[3]);
  }

  get length(): number {
    return this.offset;
  }
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  vec(): Vec3Fx {
    return { x: this.i32(), y: this.i32(), z: this.i32() };
  }

  rng(): RngState {
    return [this.u32(), this.u32(), this.u32(), this.u32()];
  }
}

function byteLength(state: SimState): number {
  return (
    HEADER_BYTES +
    PLAYER_BYTES +
    COUNT_BYTES +
    state.enemies.length * ENEMY_BYTES +
    COUNT_BYTES +
    state.projectiles.length * PROJECTILE_BYTES +
    SCORE_BYTES +
    4
  );
}

export function serializeState(state: SimState, simVersion: number): Uint8Array {
  const w = new Writer(byteLength(state));

  w.u32(MAGIC);
  w.u16(STATE_FORMAT_VERSION);
  w.u32(simVersion);
  w.u32(state.tick);
  w.u32(state.durationTicks);
  w.u32(state.ended);
  w.rng(state.rngSpawn);
  w.rng(state.rngSpread);
  w.rng(state.rngAi);
  w.rng(state.rngMisc);

  const p = state.player;
  w.u32(p.id);
  w.vec(p.pos);
  w.vec(p.vel);
  w.i32(p.yaw);
  w.i32(p.pitch);
  w.i32(p.health);
  w.u32(p.downTicks);
  w.u32(p.crouching);
  w.u32(p.grounded);
  w.u32(p.weaponSlot);
  w.u32(p.ammo[0]);
  w.u32(p.ammo[1]);
  w.u32(p.reserve[0]);
  w.u32(p.reserve[1]);
  w.u32(p.reloadTicks);
  w.u32(p.fireCooldownTicks);
  w.u32(p.shotsFired);
  w.u32(p.shotsHit);
  w.u32(p.kills);
  w.u32(p.deaths);

  w.u16(state.enemies.length);
  for (const e of state.enemies) {
    w.u32(e.id);
    w.u32(e.archetype);
    w.vec(e.pos);
    w.vec(e.vel);
    w.i32(e.yaw);
    w.i32(e.health);
    w.u32(e.brain);
    w.u32(e.brainTicks);
    w.u32(e.targetNode);
    w.u32(e.reactionTicks);
    w.u32(e.fireCooldownTicks);
  }

  w.u16(state.projectiles.length);
  for (const q of state.projectiles) {
    w.u32(q.id);
    w.u32(q.ownerId);
    w.u32(q.weapon);
    w.vec(q.pos);
    w.vec(q.vel);
    w.u32(q.lifeTicks);
  }

  w.u32(state.score.score);
  w.u32(state.score.streak);
  w.u32(state.score.comboTicks);
  w.i32(state.score.multiplier);
  w.u32(state.score.medalsMask);
  w.u32(state.waveCursor);
  w.u32(state.nextEntityId);

  return w.bytes;
}

export class StateFormatError extends Error {}

export function deserializeState(bytes: Uint8Array, simVersion: number): SimState {
  const r = new Reader(bytes);

  if (r.u32() !== MAGIC) throw new StateFormatError('not a SimState buffer');
  const format = r.u16();
  if (format !== STATE_FORMAT_VERSION) {
    throw new StateFormatError(`state format ${format} is not ${STATE_FORMAT_VERSION}`);
  }
  const version = r.u32();
  if (version !== simVersion) {
    throw new StateFormatError(`state was written by simVersion ${version}, not ${simVersion}`);
  }

  const tick = r.u32();
  const durationTicks = r.u32();
  const ended = r.u32();
  const rngSpawn = r.rng();
  const rngSpread = r.rng();
  const rngAi = r.rng();
  const rngMisc = r.rng();

  const player: PlayerState = {
    id: r.u32(),
    pos: r.vec(),
    vel: r.vec(),
    yaw: r.i32(),
    pitch: r.i32(),
    health: r.i32(),
    downTicks: r.u32(),
    crouching: r.u32(),
    grounded: r.u32(),
    weaponSlot: r.u32(),
    ammo: [r.u32(), r.u32()],
    reserve: [r.u32(), r.u32()],
    reloadTicks: r.u32(),
    fireCooldownTicks: r.u32(),
    shotsFired: r.u32(),
    shotsHit: r.u32(),
    kills: r.u32(),
    deaths: r.u32(),
  };

  const enemyCount = r.u16();
  const enemies: EnemyState[] = [];
  for (let i = 0; i < enemyCount; i++) {
    enemies.push({
      id: r.u32(),
      archetype: r.u32(),
      pos: r.vec(),
      vel: r.vec(),
      yaw: r.i32(),
      health: r.i32(),
      brain: r.u32(),
      brainTicks: r.u32(),
      targetNode: r.u32(),
      reactionTicks: r.u32(),
      fireCooldownTicks: r.u32(),
    });
  }

  const projectileCount = r.u16();
  const projectiles: ProjectileState[] = [];
  for (let i = 0; i < projectileCount; i++) {
    projectiles.push({
      id: r.u32(),
      ownerId: r.u32(),
      weapon: r.u32(),
      pos: r.vec(),
      vel: r.vec(),
      lifeTicks: r.u32(),
    });
  }

  const score = {
    score: r.u32(),
    streak: r.u32(),
    comboTicks: r.u32(),
    multiplier: r.i32(),
    medalsMask: r.u32(),
  };
  const waveCursor = r.u32();
  const nextEntityId = r.u32();

  return {
    tick,
    durationTicks,
    ended,
    rngSpawn,
    rngSpread,
    rngAi,
    rngMisc,
    nextEntityId,
    player,
    enemies,
    projectiles,
    score,
    waveCursor,
  };
}
