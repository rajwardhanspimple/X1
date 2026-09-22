/**
 * Q16.16 fixed-point arithmetic.
 *
 * Why this exists: IEEE-754 doubles are deterministic for add, subtract, multiply and divide,
 * but JIT compilers may fuse or reorder operations, and the built-in transcendental functions
 * (Math.sin, Math.cos, Math.atan2, Math.pow, Math.exp, and in the spec even Math.sqrt) are only
 * "implementation-approximated" and differ between V8, JavaScriptCore and SpiderMonkey. A run
 * verified on the server must match the browser bit for bit, so every gameplay number goes
 * through this module.
 *
 * Representation: a signed 32-bit integer holding value * 65536. Range is about +/-32768 with a
 * resolution of 1/65536. Every intermediate below stays exactly representable in a double
 * (under 2^53), so results are identical on every engine.
 *
 * Angles are measured in TURNS, not radians: FX_ONE is one full revolution. Turns make the
 * modulo reduction in sinTurns exact integer work.
 */

export type Fx = number;

export const FX_BITS = 16;
export const FX_ONE: Fx = 65536;
export const FX_HALF: Fx = 32768;
export const FX_QUARTER: Fx = 16384;
export const FX_MAX: Fx = 2147483647;
export const FX_MIN: Fx = -2147483648;

/** Exact integer -> Fx. */
export function fromInt(n: number): Fx {
  return (n * FX_ONE) | 0;
}

/** Exact rational -> Fx, truncated toward zero. Use this instead of a float literal. */
export function fromRatio(numerator: number, denominator: number): Fx {
  return Math.trunc((numerator * FX_ONE) / denominator) | 0;
}

/** Fx -> float. Display and rendering only. Never feed the result back into the sim. */
export function toFloat(a: Fx): number {
  return a / FX_ONE;
}

/** Fx -> integer, truncated toward zero. */
export function toInt(a: Fx): number {
  return Math.trunc(a / FX_ONE);
}

export function add(a: Fx, b: Fx): Fx {
  return (a + b) | 0;
}

export function sub(a: Fx, b: Fx): Fx {
  return (a - b) | 0;
}

export function neg(a: Fx): Fx {
  return -a | 0;
}

export function abs(a: Fx): Fx {
  return a < 0 ? (-a | 0) : a;
}

export function sign(a: Fx): number {
  return a === 0 ? 0 : a < 0 ? -1 : 1;
}

/**
 * Fixed-point multiply.
 *
 * a * b would reach 2^62 and lose precision, so a is split into a high and a low half.
 * ah * b reaches at most 2^46 and al * b at most 2^47: both exact in a double.
 * Math.floor rounds toward negative infinity consistently on every engine.
 */

export function mul(a: Fx, b: Fx): Fx {
  const ah = Math.floor(a / FX_ONE);
  const al = a - ah * FX_ONE;
  return (ah * b + Math.floor((al * b) / FX_ONE)) | 0;
}

/** Fixed-point divide, truncated toward zero. Division by zero saturates. */
export function div(a: Fx, b: Fx): Fx {
  if (b === 0) return a < 0 ? FX_MIN : FX_MAX;
  return Math.trunc((a * FX_ONE) / b) | 0;
}

export function min(a: Fx, b: Fx): Fx {
  return a < b ? a : b;
}

export function max(a: Fx, b: Fx): Fx {
  return a > b ? a : b;
}

export function clamp(a: Fx, lo: Fx, hi: Fx): Fx {
  return a < lo ? lo : a > hi ? hi : a;
}

/** Linear interpolation. t is clamped to [0, FX_ONE]. */
export function lerp(a: Fx, b: Fx, t: Fx): Fx {
  const k = clamp(t, 0, FX_ONE);
  return (a + mul(sub(b, a), k)) | 0;
}

/**
 * Integer square root of a non-negative integer, by Newton's method.
 * Used instead of Math.sqrt, which the ECMAScript specification does not require to be
 * correctly rounded.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  if (n < 4) return 1;
  let x = 1;
  // Bracket the root with a power of two. n is at most 2^47 here, so this runs at most 24 times.
  while (x * x < n) x *= 2;
  for (let i = 0; i < 48; i++) {
    const next = Math.floor((x + Math.floor(n / x)) / 2);
    if (next === x) break;
    x = next;
  }
  while (x * x > n) x -= 1;
  while ((x + 1) * (x + 1) <= n) x += 1;
  return x;
}

/** Fixed-point square root. sqrt(a) in Fx equals isqrt(a * FX_ONE). */
export function sqrt(a: Fx): Fx {
  if (a <= 0) return 0;
  return isqrt(a * FX_ONE) | 0;
}

/**
 * Length of a two-dimensional vector.
 *
 * The squares are summed as raw integer products before a single conversion back to Q16.16, rather
 * than being computed with mul(). That is the entire reason this exists as a helper: mul() rounds
 * each product individually, so `sqrt(add(mul(x,x), mul(y,y)))` compounds two roundings before the
 * square root sees them. For near-equal components that can land on a different integer on a
 * different engine, and a one-unit difference in an angle feeds straight into a state hash and
 * fails verification.
 *
 * isqrt of the un-shifted sum is already in Q16.16, because sqrt(v * 2^32) equals sqrt(v) * 2^16.
 *
 * Inputs are Q16.16, so each square reaches about 2^62. That exceeds the exactly representable
 * integer range, but only for coordinates above roughly 2^15 units; arena positions stay under 100,
 * where the sum is below 2^46 and exact.
 */
export function length2(x: Fx, y: Fx): Fx {
  if (x === 0 && y === 0) return 0;
  return isqrt(x * x + y * y) | 0;
}

/** Length of a three-dimensional vector. Same reasoning as length2. */
export function length3(x: Fx, y: Fx, z: Fx): Fx {
  if (x === 0 && y === 0 && z === 0) return 0;
  return isqrt(x * x + y * y + z * z) | 0;
}

// --- Trigonometry -----------------------------------------------------------------------
//
// sin(pi/2 * u) for u in [0, 1] is approximated by an odd polynomial a1*u + a3*u^3 + a5*u^5 +
// a7*u^7. The coefficients below are the Q16.16 roundings of a standard minimax fit, with a7
// nudged so the four terms sum to exactly FX_ONE: that makes sin(quarter turn) exactly 1 and
// keeps sin^2 + cos^2 within a few units of FX_ONE across the whole circle.
//
// This is deterministic because every step uses mul() above. A build-time generated exact table

// could replace it later; doing so changes outcomes and therefore requires a simVersion bump.

const A1: Fx = 102944;
const A3: Fx = -42334;
const A5: Fx = 5205;
const A7: Fx = -279;

/** sin(quarter * u) for u in [0, FX_ONE]. */
function sinQuarter(u: Fx): Fx {
  const u2 = mul(u, u);
  const u3 = mul(u2, u);
  const u5 = mul(u3, u2);
  const u7 = mul(u5, u2);
  return (mul(A1, u) + mul(A3, u3) + mul(A5, u5) + mul(A7, u7)) | 0;
}

/**
 * sin of an angle in turns.
 *
 * Reduced to a quadrant by exact integer arithmetic, then evaluated on [0, quarter]. Exact at the
 * four cardinal angles, which matters because axis-aligned movement and shots are common.
 */
export function sinTurns(t: Fx): Fx {
  let a = t % FX_ONE;
  if (a < 0) a += FX_ONE;

  if (a === 0) return 0;
  if (a === FX_QUARTER) return FX_ONE;
  if (a === FX_HALF) return 0;
  if (a === FX_HALF + FX_QUARTER) return -FX_ONE;

  if (a < FX_QUARTER) return sinQuarter(div(a, FX_QUARTER));
  if (a < FX_HALF) return sinQuarter(div((FX_HALF - a) | 0, FX_QUARTER));
  if (a < FX_HALF + FX_QUARTER) return -sinQuarter(div((a - FX_HALF) | 0, FX_QUARTER)) | 0;
  return -sinQuarter(div((FX_ONE - a) | 0, FX_QUARTER)) | 0;
}

/** cos of an angle in turns. */
export function cosTurns(t: Fx): Fx {
  return sinTurns((t + FX_QUARTER) | 0);
}

// atan on [-1, 1] in turns, from the standard two-term rational approximation. Maximum error is
// about 0.0005 of a turn, and it is exact at 0 and at 1.
const ATAN_K1: Fx = fromRatio(1, 8);
const ATAN_K2: Fx = fromRatio(28, 1000);

/** atan(z) in turns for |z| <= 1. */
function atanUnitTurns(z: Fx): Fx {
  return (mul(ATAN_K1, z) - mul(mul(ATAN_K2, z), (abs(z) - FX_ONE) | 0)) | 0;
}

/**
 * atan2 in turns, result in [0, FX_ONE). Reduced by octant so the approximation only ever sees
 * |z| <= 1. Accuracy is about 0.001 of a turn, which is fine for enemy facing; player aim comes
 * from recorded input deltas and never goes through here.
 */
export function atan2Turns(y: Fx, x: Fx): Fx {
  if (x === 0 && y === 0) return 0;
  const ax = abs(x);
  const ay = abs(y);
  let r: Fx;
  if (ax >= ay) {
    r = atanUnitTurns(div(ay, ax));
  } else {
    r = (FX_QUARTER - atanUnitTurns(div(ax, ay))) | 0;
  }
  if (x < 0) r = (FX_HALF - r) | 0;
  if (y < 0) r = -r | 0;
  if (r < 0) r = (r + FX_ONE) | 0;
  return r % FX_ONE;
}


/** Shortest signed difference between two angles in turns, in (-FX_HALF, FX_HALF]. */
export function angleDiffTurns(a: Fx, b: Fx): Fx {
  let d = (a - b) % FX_ONE;
  if (d < 0) d += FX_ONE;
  if (d > FX_HALF) d -= FX_ONE;
  return d | 0;
}
