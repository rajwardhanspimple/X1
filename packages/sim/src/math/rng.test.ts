import { describe, expect, it } from 'vitest';
import {
  cloneRng,
  createRng,
  nextBelow,
  nextChance,
  nextFx,
  nextRangeFx,
  nextU32,
  RngStream,
} from './rng.js';
import { FX_ONE } from './fixed.js';

describe('seeded random', () => {
  it('produces the same stream for the same seed', () => {
    const a = createRng(12345, RngStream.Spawn);
    const b = createRng(12345, RngStream.Spawn);
    for (let i = 0; i < 64; i++) {
      expect(nextU32(a)).toBe(nextU32(b));
    }
  });

  it('produces different streams for different seeds', () => {
    const a = createRng(1, RngStream.Spawn);
    const b = createRng(2, RngStream.Spawn);
    const drawsA = Array.from({ length: 8 }, () => nextU32(a));
    const drawsB = Array.from({ length: 8 }, () => nextU32(b));
    expect(drawsA).not.toEqual(drawsB);
  });

  it('keeps sub-streams independent for one seed', () => {
    const seed = 987654;
    const spawn = createRng(seed, RngStream.Spawn);
    const spread = createRng(seed, RngStream.Spread);
    const ai = createRng(seed, RngStream.Ai);
    const drawsSpawn = Array.from({ length 8 }, () => nextU32(spawn));
    const drawsSpread = Array.from({ length: 8 }, () => nextU32(spread));
    const drawsAi = Array.from({ length: 8 }, () => nextU32(ai));
    expect(drawsSpawn).not.toEqual(drawsSpread);
    expect(drawsSpread).not.toEqual(drawsAi);
  });

  it('is not shifted in one stream by extra draws in another', () => {
    const seed = 4242;
    // Baseline: read spawn without touching spread.
    const spawnA = createRng(seed, RngStream.Spawn);
    const baseline = Array.from({ length: 5 }, () => nextU32(spawnA));
    // Now burn a pile of draws on spread first. Spawn must be unaffected.
    const spread = createRng(seed, RngStream.Spread);
    for (let i = 0; i < 100; i++) nextU32(spread);
    const spawnB = createRng(seed, RngStream.Spawn);
    const after = Array.from({ length: 5 }, () => nextU32(spawnB));
    expect(after).toEqual(baseline);
  });

  it('emits unsigned 32-bit integers', () => {
    const s = createRng(7, RngStream.Misc);
    for (let i = 0; i < 500; i++) {
      const v = nextU32(s);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(4294967295);
    }
  });

  it('resumes exactly from a cloned state', () => {
    const s = createRng(31337, RngStream.Ai);
    for (let i = 0; i < 10; i++) nextU32(s);
    const saved = cloneRng(s);
    const expected = Array.from({ length: 10 }, () => nextU32(s));
    const restored = cloneRng(saved);
    const actual = Array.from({ length: 10 }, () => nextU32(restored));
    expect(actual).toEqual(expected);
  });

  it('snapshots the first draws per stream', () => {
    const streams = [RngStream.Spawn, RngStream.Spread, RngStream.Ai, RngStream.Misc];
    const table = streams.map((id) => {
      const s = createRng(2026, id);
      return Array.from({ length: 4 }, () => nextU32(s));
    });
    expect(table).toMatchSnapshot();
  });
});

describe('bounded draws', () => {
  it('stays inside the bound', () => {
    const s = createRng(99, RngStream.Spawn);
    for (let i = 0; i < 2000; i++) {
      const v = nextBelow(s, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('treats a bound of one or less as zero', () => {
    const s = createRng(5, RngStream.Misc);
    expect(nextBelow(s, 1)).toBe(0);
    expect(nextBelow(s, 0)).toBe(0);
  });

  it('covers every bucket over enough draws', () => {
    const s = createRng(2718, RngStream.Spread);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(nextBelow(s, 6));
    expect(seen.size).toBe(6);
  });

  it('keeps fixed-point draws inside one unit', () => {
    const s = createRng(161803, RngStream.Spread);
    for (let i = 0; i < 1000; i++) {
      const v = nextFx(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(FX_ONE);
    }
  });

  it('respects an inclusive fixed-point range', () => {
    const s = createRng(11, RngStream.Spread);
    for (let i = 0; i < 500; i++) {
      const v = nextRangeFx(s, -1000, 1000);
      expect(v).toBeGreaterThanOrEqual(-1000);
      expect(v).toBeLessThanOrEqual(1000);
    }
    expect(nextRangeFx(s, 500, 500)).toBe(500);
    expect(nextRangeFx(s, 500, 100)).toBe(500);
  });

  it('never fires at zero chance and always fires at full chance', () => {
    const s = createRng(13, RngStream.Misc);
    for (let i = 0; i < 100; i++) {
      expect(nextChance(s, 0)).toBe(false);
      expect(nextChance(s, FX_ONE)).toBe(true);
    }
  });
});
