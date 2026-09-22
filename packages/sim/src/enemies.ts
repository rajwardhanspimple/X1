/**
 * Enemy archetypes.
 *
 * Built in until content authoring exists (WO-52). Values are per-tick or Q16.16 so they hash
 * exactly. The three archetypes exist to make waves read differently: a rusher forces you to move,
 * a rifleman punishes standing in the open, a heavy soaks damage and pushes you off a position.
 */

import * as fx from './math/fixed.js';

export interface EnemyArchetype {
  id: string;
  index: number;
  health: fx.Fx;
  /** Movement speed per tick. */
  speed: fx.Fx;
  /** How far the enemy can see the player. */
  sightRange: fx.Fx;
  /** How close it tries to get before holding position. */
  preferredRange: fx.Fx;
  /** Ticks between acquiring the player and the first shot. Fairness: never instant. */
  reactionTicks: number;
  /** Ticks between shots. */
  fireIntervalTicks: number;
  /** Damage per hit. */
  damage: fx.Fx;
  /** Chance in Q16.16 that a shot hits, before distance scaling. */
  accuracy: fx.Fx;
  /** Score awarded for a kill. */
  scoreValue: number;
  /** Ticks of telegraph before firing, so the player can react. */
  telegraphTicks: number;
}

export const ARCHETYPES: readonly EnemyArchetype[] = [
  {
    id: 'rusher',
    index: 0,
    health: fx.fromInt(45),
    speed: fx.fromRatio(62 * 100, 60 * 1000),
    sightRange: fx.fromInt(42),
    preferredRange: fx.fromInt(3),
    reactionTicks: 16,
    fireIntervalTicks: 26,
    damage: fx.fromInt(9),
    accuracy: fx.fromRatio(52, 100),
    scoreValue: 100,
    telegraphTicks: 10,
  },
  {
    id: 'rifleman',
    index: 1,
    health: fx.fromInt(70),
    speed: fx.fromRatio(38 * 100, 60 * 1000),
    sightRange: fx.fromInt(55),
    preferredRange: fx.fromInt(16),
    reactionTicks: 24,
    fireIntervalTicks: 42,
    damage: fx.fromInt(13),
    accuracy: fx.fromRatio(60, 100),
    scoreValue: 150,
    telegraphTicks: 14,
  },
  {
    id: 'heavy',
    index: 2,
    health: fx.fromInt(160),
    speed: fx.fromRatio(26 * 100, 60 * 1000),
    sightRange: fx.fromInt(38),
    preferredRange: fx.fromInt(9),
    reactionTicks: 32,
    fireIntervalTicks: 34,
    damage: fx.fromInt(17),
    accuracy: fx.fromRatio(46, 100),
    scoreValue: 250,
    telegraphTicks: 20,
  },
];

export function archetypeByIndex(index: number): EnemyArchetype {
  return ARCHETYPES[index] ?? ARCHETYPES[0]!;
}

/** Brain states. Stored as integers in EnemyState.brain, so the order must stay stable. */
export const Brain = {
  Idle: 0,
  Advance: 1,
  Engage: 2,
  Retreat: 3,
} as const;
