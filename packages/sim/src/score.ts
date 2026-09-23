/**
 * ScoreEngine.
 *
 * Score lives entirely in the simulation, never in the client: the verifier recomputes it from the
 * inputs and compares, so a client-side score would be worthless. Every value is an integer.
 *
 * The combo window is what makes scoring interesting: consecutive kills inside the window multiply,
 * so pushing for a fast second kill is worth more than playing safe. The multiplier is part of the
 * hashed state.
 */

import { archetypeByIndex } from './enemies.js';
import * as fx from './math/fixed.js';
import type { SimState } from './state.js';
import type { CombatEvent } from './combat.js';

/** Ticks a kill keeps the combo alive. 240 is four seconds. */
const COMBO_WINDOW_TICKS = 240;
/** Added to the multiplier per combo step. */
const COMBO_STEP = fx.fromRatio(25, 100);
const MAX_MULTIPLIER = fx.fromInt(4);
/** Bonus for a headshot kill, before the multiplier. */
const HEADSHOT_BONUS = 50;
/** Bonus for clearing a wave. */
const WAVE_CLEAR_BONUS = 250;
/** Headshots needed for Marksman. */
const MARKSMAN_HEADSHOTS = 5;

/** Medal ids as bit positions in ScoreState.medalsMask. Order must stay stable. */
export const Medal = {
  FirstBlood: 0,
  DoubleKill: 1,
  TripleKill: 2,
  Marksman: 3, // five headshots in a round
  Survivor: 4, // clear three waves without dying
  Untouchable: 5, // clear a wave without taking damage
} as const;

export const MEDAL_NAMES: readonly string[] = [
  'First Blood',
  'Double Kill',
  'Triple Kill',
  'Marksman',
  'Survivor',
  'Untouchable',
];

function award(state: SimState, medal: number): boolean {
  const bit = 1 << medal;
  if ((state.score.medalsMask & bit) !== 0) return false;
  state.score.medalsMask |= bit;
  return true;
}

export interface ScoreOutcome {
  /** Medals awarded this tick, for the HUD callout queue. */
  medals: number[];
  /** Points added this tick, for a floating score indicator. */
  points: number;
}

/**
 * Apply this tick's combat events to the score.
 *
 * Called after combat so kills are already resolved, and before the end-of-round check so the last
 * tick's kills still count.
 *
 * The headshot tally lives in `state.score.headshots` rather than being passed in. It used to be a mutable box owned by
 * the kernel, which meant it was not serialised: a sliced replay restored it as zero and could miss Marksman that a
 * single-pass replay awarded. Anything that accumulates across ticks and affects an outcome has to be in SimState, or the
 * verifier and the browser disagree.
 */
export function stepScore(
  state: SimState,
  events: readonly CombatEvent[],
  waveCleared: boolean,
): ScoreOutcome {
  const medals: number[] = [];
  let points = 0;
  const score = state.score;

  let killsThisTick = 0;
  for (const event of events) {
    if (event.kind === 'headshot') {
      score.headshots += 1;
      // The bonus is awarded here rather than on the kill, because a headshot and its kill are separate events.
      const bonus = fx.toInt(fx.mul(fx.fromInt(HEADSHOT_BONUS), score.multiplier));
      score.score += bonus;
      points += bonus;
    }
    if (event.kind !== 'kill') continue;

    killsThisTick += 1;

    // The enemy is already at zero health but still in the array, so its value is readable.
    const enemy = state.enemies.find((e) => e.id === event.targetId);
    const base = enemy ? archetypeByIndex(enemy.archetype).scoreValue : 100;

    // A kill inside the combo window raises the multiplier; otherwise it resets to one.
    if (score.comboTicks > 0) {
      score.multiplier = fx.min((score.multiplier + COMBO_STEP) | 0, MAX_MULTIPLIER);
    } else {
      score.multiplier = fx.FX_ONE;
    }
    score.comboTicks = COMBO_WINDOW_TICKS;
    score.streak += 1;

    const awarded = fx.toInt(fx.mul(fx.fromInt(base), score.multiplier));
    score.score += awarded;
    points += awarded;

    if (score.streak === 1 && award(state, Medal.FirstBlood)) medals.push(Medal.FirstBlood);
  }

  if (killsThisTick >= 2 && award(state, Medal.DoubleKill)) medals.push(Medal.DoubleKill);
  if (killsThisTick >= 3 && award(state, Medal.TripleKill)) medals.push(Medal.TripleKill);
  if (score.headshots >= MARKSMAN_HEADSHOTS && award(state, Medal.Marksman)) {
    medals.push(Medal.Marksman);
  }

  if (waveCleared) {
    const bonus = fx.toInt(fx.mul(fx.fromInt(WAVE_CLEAR_BONUS), score.multiplier));
    score.score += bonus;
    points += bonus;
    if (state.waveCursor >= 3 && state.player.deaths === 0 && award(state, Medal.Survivor)) {
      medals.push(Medal.Survivor);
    }
  }

  return { medals, points };
}

/** End-of-round bonus: remaining health counts, so surviving is worth something. */
export function applyEndOfRoundBonus(state: SimState): void {
  const healthFraction = fx.clamp(state.player.health, 0, fx.fromInt(100));
  state.score.score += fx.toInt(healthFraction) * 2;
}

/** Medal names for a mask, in bit order, for the results screen. */
export function medalNames(mask: number): string[] {
  const names: string[] = [];
  for (let bit = 0; bit < MEDAL_NAMES.length; bit++) {
    if ((mask & (1 << bit)) !== 0) names.push(MEDAL_NAMES[bit]!);
  }
  return names;
}
