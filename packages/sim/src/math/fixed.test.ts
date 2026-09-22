import { describe, expect, it } from 'vitest';
import * as fx from './fixed.js';

/**
 * These tests are the contract for AC-ARM-007: the same inputs must produce the same numbers on
 * every engine. The snapshot blocks are deliberate. If a constant or an algorithm changes, they
 * fail, which is the signal that SIM_VERSION must be bumped and old boards archived.
 */
describe('fixed-point conversion', () => {
  it('round trips integers', () => {
    for (const n of [-1000, -1, 0, 1, 7, 255, 32767]) {
      expect(fx.toInt(fx.fromInt(n))).toBe(n);
    }
  });

  it('builds exact rationals', () => {
    expect(fx.fromRatio(1, 2)).toBe(32768);
    expect(fx.fromRatio(1, 4)).toBe(16384);
    expect(fx.fromRatio(3, 4)).toBe(49152);
    expect(fx.fromRatio(-1, 2)).toBe(-32768);
  });

  it('truncates toward zero on conversion to int', () => {
    expect(fx.toInt(fx.fromRatio(7, 2))).toBe(3);
    expect(fx.toInt(fx.fromRatio(-7, 2))).toBe(-3);
  });
});

describe('fixed-point arithmetic', () => {
  it('multiplies by one and zero exactly', () => {
    for (const v of [0, 1, 12345, -98765, fx.FX_ONE, -fx.FX_ONE]) {
      expect(fx.mul(v, fx.FX_ONE)).toBe(v);
      expect(fx.mul(v, 0)).toBe(0);
    }
  });

  it('multiplies halves and quarters exactly', () => {
    expect(fx.mul(fx.FX_ONE, fx.FX_HALF)).toBe(fx.FX_HALF);
    expect(fx.mul(fx.FX_HALF, fx.FX_HALF)).toBe(fx.FX_QUARTER);
    expect(fx.mul(fx.fromInt(3), fx.FX_HALF)).toBe(fx.fromRatio(3, 2));
  });

  it('multiplies negatives consistently', () => {
    expect(fx.mul(-fx.FX_HALF, fx.FX_HALF)).toBe(-fx.FX_QUARTER);
    expect(fx.mul(-fx.FX_HALF, -fx.FX_HALF)).toBe(fx.FX_QUARTER);
  });

  it('divides exactly for powers of two', () => {
    expect(fx.div(fx.FX_ONE, fx.fromInt(2))).toBe(fx.FX_HALF);
    expect(fx.div(fx.FX_ONE, fx.fromInt(4))).toBe(fx.FX_QUARTER);
    expect(fx.div(fx.fromInt(10), fx.fromInt(4))).toBe(fx.fromRatio(10, 4));
  });

  it('saturates instead of producing Infinity or NaN', () => {
    expect(fx.div(fx.FX_ONE, 0)).toBe(fx.FX_MAX);
    expect(fx.div(-fx.FX_ONE, 0)).toBe(fx.FX_MIN);
  });

  it('clamps and lerps at the endpoints', () => {
    expect(fx.clamp(fx.fromInt(5), 0, fx.fromInt(3))).toBe(fx.fromInt(3));
    expect(fx.clamp(fx.fromInt(-5), 0, fx.fromInt(3))).toBe(0);
    expect(fx.lerp(0, fx.fromInt(10), 0)).toBe(0);
    expect(fx.lerp(0, fx.fromInt(10), fx.FX_ONE)).toBe(fx.fromInt(10));
    expect(fx.lerp(0, fx.fromInt(10), fx.FX_HALF)).toBe(fx.fromInt(5));
  });
});

describe('integer square root', () => {
  it('is exact on perfect squares', () => {
    for (const n of [0, 1, 4, 9, 16, 144, 65536, 1048576, 16777216]) {
      expect(fx.isqrt(n)).toBe(Math.round(Math.sqrt(n)));
    }
  });

  it('floors between squares', () => {
    expect(fx.isqrt(8)).toBe(2);
    expect(fx.isqrt(15)).toBe(3);
    expect(fx.isqrt(99)).toBe(9);
  });

  it('satisfies the bracketing invariant on a wide sweep', () => {
    for (let n = 0; n < 5000; n += 7) {
      const r = fx.isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
  });

  it('square roots fixed-point values', () => {
    expect(fx.sqrt(fx.fromInt(4))).toBe(fx.fromInt(2));
    expect(fx.sqrt(fx.fromInt(9))).toBe(fx.fromInt(3));
    expect(fx.sqrt(fx.FX_ONE)).toBe(fx.FX_ONE);
    expect(fx.sqrt(0)).toBe(0);
    expect(fx.sqrt(-5)).toBe(0);
  });
});

describe('trigonometry in turns', () => {
  it('hits the cardinal angles', () => {
    expect(fx.sinTurns(0)).toBe(0);
    expect(fx.sinTurns(fx.FX_QUARTER)).toBe(fx.FX_ONE);
    expect(fx.sinTurns(fx.FX_HALF)).toBe(0);
    expect(fx.sinTurns(fx.FX_HALF + fx.FX_QUARTER)).toBe(-fx.FX_ONE);
    expect(fx.cosTurns(0)).toBe(fx.FX_ONE);
    expect(fx.cosTurns(fx.FX_QUARTER)).toBe(0);
    expect(fx.cosTurns(fx.FX_HALF)).toBe(-fx.FX_ONE);
  });

  it('is odd and wraps a full turn', () => {
    for (let t = 0; t < fx.FX_ONE; t += 977) {
      expect(fx.sinTurns(-t)).toBe(-fx.sinTurns(t));
      expect(fx.sinTurns(t + fx.FX_ONE)).toBe(fx.sinTurns(t));
      expect(fx.sinTurns(t - fx.FX_ONE)).toBe(fx.sinTurns(t));
    }
  });

  it('keeps sin^2 + cos^2 close to one', () => {
    let worst = 0;
    for (let t = 0; t < fx.FX_ONE; t += 149) {
      const s = fx.sinTurns(t);
      const c = fx.cosTurns(t);
      const sum = fx.add(fx.mul(s, s), fx.mul(c, c));
      worst = Math.max(worst, Math.abs(sum - fx.FX_ONE));
    }
    // Within 0.5% of unity across the circle; exactness is not required, reproducibility is.
    expect(worst).toBeLessThan(fx.FX_ONE / 200);
  });

  it('tracks the real sine within a small tolerance', () => {
    for (let t = 0; t < fx.FX_ONE; t += 1021) {
      const got = fx.toFloat(fx.sinTurns(t));
      const want = Math.sin((t / fx.FX_ONE) * 2 * Math.PI);
      expect(Math.abs(got - want)).toBeLessThan(0.002);
    }
  });

  it('snapshots sine values so a coefficient change is caught', () => {
    const samples = [0, 4096, 8192, 12288, 16384, 24576, 32768, 49152].map((t) =>
      fx.sinTurns(t),
    );
    expect(samples).toMatchSnapshot();
  });
});

describe('atan2 in turns', () => {
  it('resolves the axes', () => {
    const one = fx.FX_ONE;
    expect(fx.atan2Turns(0, one)).toBe(0);
    expect(fx.atan2Turns(0, 0)).toBe(0);
    expect(Math.abs(fx.atan2Turns(one, 0) - fx.FX_QUARTER)).toBeLessThan(64);
    expect(Math.abs(fx.atan2Turns(0, -one) - fx.FX_HALF)).toBeLessThan(64);
  });

  it('returns a value inside one turn for every octant', () => {
    const one = fx.FX_ONE;
    const pairs: Array<[number, number]> = [
      [one, one],
      [one, -one],
      [-one, one],
      [-one, -one],
      [one, fx.FX_HALF],
      [-fx.FX_HALF, one],
    ];
    for (const [y, x] of pairs) {
      const r = fx.atan2Turns(y, x);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(fx.FX_ONE);
    }
  });

  it('agrees with the real atan2 within a small tolerance', () => {
    const one = fx.FX_ONE;
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * 2 * Math.PI;
      const y = Math.round(Math.sin(angle) * one);
      const x = Math.round(Math.cos(angle) * one);
      const got = fx.toFloat(fx.atan2Turns(y, x));
      let want = angle / (2 * Math.PI);
      if (want < 0) want += 1;
      const diff = Math.min(Math.abs(got - want), 1 - Math.abs(got - want));
      expect(diff).toBeLessThan(0.005);
    }
  });

  it('snapshots atan2 values', () => {
    const one = fx.FX_ONE;
    const samples = [
      fx.atan2Turns(one, one),
      fx.atan2Turns(one, -one),
      fx.atan2Turns(-one, one),
      fx.atan2Turns(-one, -one),
    ];
    expect(samples).toMatchSnapshot();
  });
});

describe('angle difference', () => {
  it('takes the short way round', () => {
    expect(fx.angleDiffTurns(fx.FX_QUARTER, 0)).toBe(fx.FX_QUARTER);
    expect(fx.angleDiffTurns(0, fx.FX_QUARTER)).toBe(-fx.FX_QUARTER);
    // Just past half a turn resolves as a small negative difference, not a large positive one.
    expect(fx.angleDiffTurns(fx.FX_HALF + 1000, 0)).toBe(-(fx.FX_HALF - 1000));
  });
});
