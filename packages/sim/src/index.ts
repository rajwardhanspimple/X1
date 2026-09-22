/**
 * RE:Arena Sim Core public entry.
 *
 * Determinism rules (enforced by ESLint in eslint.config.js and by the CI determinism workflow):
 * - No Math.random, Date, performance, or timers. Randomness comes only from SeededRandom.
 * - No IEEE transcendentals in gameplay code. Use the fixed-point helpers.
 * - One tick per InputFrame. The tick counter is the only clock.
 * - Iterate entities by ascending integer id.
 * - SimState stays fully serialisable: serialize -> restore must hash identically.
 * - Any change that alters an outcome for the same inputs bumps SIM_VERSION.
 *
 * This package has no DOM and no Node dependencies, so the same build runs in the browser Web
 * Worker, in Node for tests, and in Deno inside the verify-run Edge Function.
 */

export {
  SIM_VERSION,
  createSimulation,
  restoreSimulation,
  serializeSimulation,
  hashSimulation,
  step,
  snapshot,
  summary,
  isCheckpointTick,
  isEnded,
  type SimContent,
  type Simulation,
} from './kernel.js';

export { replay, replaySlice, type ReplayOptions, type SliceOptions } from './replay.js';

export {
  serializeState,
  deserializeState,
  StateFormatError,
  STATE_FORMAT_VERSION,
} from './serialize.js';

export {
  createInitialState,
  vec3,
  type SimState,
  type PlayerState,
  type EnemyState,
  type ProjectileState,
  type ScoreState,
  type Vec3Fx,
} from './state.js';

export * as FixedMath from './math/fixed.js';
export {
  createRng,
  cloneRng,
  nextU32,
  nextBelow,
  nextFx,
  nextRangeFx,
  nextChance,
  RngStream,
  type RngState,
  type RngStreamId,
} from './math/rng.js';
export { hash64, xxhash32 } from './hash/xxhash32.js';
