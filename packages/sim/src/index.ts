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
  events,
  playerShape,
  isCheckpointTick,
  isEnded,
  type SimContent,
  type Simulation,
  type TickEvents,
} from './kernel.js';

export { replay, replaySlice, type ReplayOptions, type SliceOptions } from './replay.js';

/**
 * Aim assist is exported for tests and for the verifier, not for the client: the client only sets the
 * InputFlags.AimAssist bit and lets the simulation do the work. See ADR-001 in the Gamepad Support blueprint.
 */
export {
  computeAimAssist,
  applyAimAssist,
  scaleLookForAssist,
  type AimAssistResult,
} from './aim-assist.js';

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

export {
  boxFromCentre,
  createCollisionWorld,
  isGrounded,
  pointInSolid,
  raycast,
  resolveMove,
  type BodyShape,
  type BoxFx,
  type CollisionWorld,
  type MoveResult,
  type RayHit,
} from './collision.js';

export {
  bodyShape,
  eyeOffset,
  stepPlayerMovement,
  EYE_OFFSET_CROUCH,
  EYE_OFFSET_STAND,
  type MovementFields,
} from './movement.js';

export { WEAPONS, weaponByIndex, weaponById, damageAtDistance, type WeaponDef } from './weapons.js';

export { stepWeapons, reapEnemies, type CombatEvent } from './combat.js';

export { ARCHETYPES, archetypeByIndex, Brain, type EnemyArchetype } from './enemies.js';

export { stepEnemies, stepRespawn, type EnemyEvent } from './ai.js';

export { planWave, stepWaves, isWaveCleared, type WavePlan } from './waves.js';

export {
  stepScore,
  applyEndOfRoundBonus,
  medalNames,
  Medal,
  MEDAL_NAMES,
  type ScoreOutcome,
} from './score.js';

export {
  createGreyboxWorld,
  greyboxPlayerSpawns,
  greyboxEnemySpawns,
  GREYBOX_BRUSHES,
  GREYBOX_SPAWNS,
  GREYBOX_ENEMY_SPAWNS,
  ARENA_HALF,
  WALL_HEIGHT,
  type BrushDescriptor,
} from './layout.js';

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
