/**
 * Deterministic pseudo-random numbers for the simulation.
 *
 * xoshiro128** with splitmix32 seeding. Every operation is 32-bit integer work through
 * Math.imul and unsigned shifts, so the stream is identical on every JavaScript engine.
 * Math.random is banned in this package (enforced by ESLint).
 *
 * Sub-streams: each system draws from its own stream, derived from the match seed and a fixed
 * label. Adding or removing a draw in one system therefore cannot shift the values another
 * system sees, which keeps determinism changes localised and reviewable.
 */

/** Four unsigned 32-bit words. Mutated in place by next(); part of the serialised SimState. */
export type RngState = [number, number, number, number];

/** Fixed stream labels. Never renumber these: the numbers are part of the seeding. */
export const RngStream = {
  Spawn: 1,
  Spread: 2,
  Ai: 3,
  Misc: 4,
} as const;
export type RngStreamId = (typeof RngStream)[keyof typeof RngStream];

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/** Build a stream from the match seed and a stream label. */
export function createRng(seed: number, stream: RngStreamId | number): RngState {
  const mix = splitmix32((seed ^ Math.imul(stream, 0x9e3779b9)) | 0);
  const state: RngState = [mix(), mix(), mix(), mix()];
  if ((state[0] | state[1] | state[2] | state[3]) === 0) state[0] = 1;
  return state;
}

export function cloneRng(s: RngState): RngState {
  return [s[0], s[1], s[2], s[3]];
}

/** Next unsigned 32-bit value. Advances the state. */
export function nextU32(s: RngState): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result;
}

/**
 * Uniform integer in [0, bound). Rejection sampling, so the result is unbiased and the number of
 * draws depends only on the stream, never on the host.
 */
export function nextBelow(s: RngState, bound: number): number {
  if (bound <= 1) return 0;
  const limit = Math.floor(4294967296 / bound) * bound;
  let v = nextU32(s);
  let guard = 0;
  while (v >= limit && guard < 64) {
    v = nextU32(s);
    guard += 1;
  }
  return v % bound;
}

/** Uniform Q16.16 value in [0, FX_ONE). */
export function nextFx(s: RngState): number {
  return nextU32(s) >>> 16;
}

/** Uniform Q16.16 value in [lo, hi]. */
export function nextRangeFx(s: RngState, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return (lo + nextBelow(s, hi - lo + 1)) | 0;
}

/** True with probability chanceFx / FX_ONE. */
export function nextChance(s: RngState, chanceFx: number): boolean {
  return nextFx(s) < chanceFx;
}
