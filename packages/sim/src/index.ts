/**
 * RE:Arena Sim Core public entry.
 *
 * Determinism rules (see RE:Arena Sim Core blueprint):
 * - No Math.random, Date, performance, timers. Only SeededRandom.
 * - No built-in transcendental functions. Only FixedMath.
 * - One tick per InputFrame. The tick counter is the only clock.
 * - Iterate entities by ascending integer id.
 * - Any outcome-changing edit increments SIM_VERSION.
 */
export const SIM_VERSION = 1 as const;

// Public API is added by WO-17 (FixedMath, SeededRandom) and WO-19 (SimulationKernel, StateHasher, ReplayRunner).
