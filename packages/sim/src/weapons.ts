/**
 * Weapon definitions.
 *
 * These land in content when the pipeline exists (WO-7); until then they are built in so the
 * gameplay systems have something to read. Every value is an integer: ticks, Q16.16, or a plain
 * count, because the weapon numbers feed the state hash and a float would risk differing between
 * engines.
 *
 * Rates are expressed as ticks between shots rather than rounds per minute, because the tick is the
 * only clock the simulation has. The comment gives the human figure.
 */

import * as fx from './math/fixed.js';

export interface WeaponDef {
  id: string;
  /** Index into the weapon table. Stored in state, so the order must stay stable. */
  index: number;
  /** Ticks between shots. 6 ticks at 60 Hz is 600 rounds per minute. */
  fireIntervalTicks: number;
  /** False for single-shot weapons: the fire button must be released between shots. */
  automatic: boolean;
  magazine: number;
  reserve: number;
  reloadTicks: number;
  /** Damage at or inside falloffStart, in Q16.16 health units. */
  damage: fx.Fx;
  /** Multiplier applied to a head hit. */
  headshotMultiplier: fx.Fx;
  /** Full damage up to this distance. */
  falloffStart: fx.Fx;
  /** Minimum damage beyond this distance. */
  falloffEnd: fx.Fx;
  /** Fraction of damage retained past falloffEnd. */
  falloffFloor: fx.Fx;
  /** Maximum travel distance of a hitscan shot. */
  range: fx.Fx;
  /** Cone half-angle in turns while hip firing. */
  spreadHip: fx.Fx;
  /** Cone half-angle in turns while aiming down sights. */
  spreadAds: fx.Fx;
  /** Extra spread added per shot in a burst, up to spreadMax. */
  spreadPerShot: fx.Fx;
  spreadMax: fx.Fx;
  /** Spread recovery per tick when not firing. */
  spreadRecovery: fx.Fx;
  /** Upward camera kick per shot, in turns. */
  recoilPitch: fx.Fx;
  /** Recoil recovery per tick. */
  recoilRecovery: fx.Fx;
  /** Pellets per shot. Above one, each pellet rolls its own spread. */
  pellets: number;
}

/** One ten-thousandth of a turn, a convenient unit for small angles. */
const TURN_10K = fx.fromRatio(1, 10000);

function turns(tenThousandths: number): fx.Fx {
  return (TURN_10K * tenThousandths) | 0;
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 'rifle-01',
    index: 0,
    fireIntervalTicks: 7, // ~514 rpm
    automatic: true,
    magazine: 30,
    reserve: 120,
    reloadTicks: 126, // 2.1 s
    damage: fx.fromInt(24),
    headshotMultiplier: fx.fromRatio(20, 10),
    falloffStart: fx.fromInt(25),
    falloffEnd: fx.fromInt(55),
    falloffFloor: fx.fromRatio(65, 100),
    range: fx.fromInt(120),
    spreadHip: turns(38),
    spreadAds: turns(8),
    spreadPerShot: turns(6),
    spreadMax: turns(120),
    spreadRecovery: turns(4),
    recoilPitch: turns(10),
    recoilRecovery: turns(4),
    pellets: 1,
  },
  {
    id: 'smg-01',
    index: 1,
    fireIntervalTicks: 5, // 720 rpm
    automatic: true,
    magazine: 35,
    reserve: 140,
    reloadTicks: 108, // 1.8 s
    damage: fx.fromInt(17),
    headshotMultiplier: fx.fromRatio(17, 10),
    falloffStart: fx.fromInt(14),
    falloffEnd: fx.fromInt(34),
    falloffFloor: fx.fromRatio(50, 100),
    range: fx.fromInt(80),
    spreadHip: turns(52),
    spreadAds: turns(18),
    spreadPerShot: turns(8),
    spreadMax: turns(150),
    spreadRecovery: turns(5),
    recoilPitch: turns(7),
    recoilRecovery: turns(4),
    pellets: 1,
  },
  {
    id: 'pistol-01',
    index: 2,
    fireIntervalTicks: 11,
    automatic: false,
    magazine: 12,
    reserve: 48,
    reloadTicks: 84, // 1.4 s
    damage: fx.fromInt(31),
    headshotMultiplier: fx.fromRatio(22, 10),
    falloffStart: fx.fromInt(18),
    falloffEnd: fx.fromInt(40),
    falloffFloor: fx.fromRatio(60, 100),
    range: fx.fromInt(90),
    spreadHip: turns(26),
    spreadAds: turns(5),
    spreadPerShot: turns(14),
    spreadMax: turns(90),
    spreadRecovery: turns(7),
    recoilPitch: turns(16),
    recoilRecovery: turns(6),
    pellets: 1,
  },
];

export function weaponByIndex(index: number): WeaponDef {
  return WEAPONS[index] ?? WEAPONS[0]!;
}

export function weaponById(id: string): WeaponDef | undefined {
  return WEAPONS.find((w) => w.id === id);
}

/**
 * Damage at a distance.
 *
 * Full damage inside falloffStart, linearly down to falloffFloor at falloffEnd, flat beyond it.
 * All fixed-point, so the result is identical everywhere.
 */
export function damageAtDistance(def: WeaponDef, distance: fx.Fx): fx.Fx {
  if (distance <= def.falloffStart) return def.damage;
  if (distance >= def.falloffEnd) return fx.mul(def.damage, def.falloffFloor);
  const span = (def.falloffEnd - def.falloffStart) | 0;
  const into = (distance - def.falloffStart) | 0;
  const t = fx.div(into, span);
  const scale = fx.lerp(fx.FX_ONE, def.falloffFloor, t);
  return fx.mul(def.damage, scale);
}
