import { describe, expect, it } from 'vitest';
import { isoWeekStart, periodEnd } from './period-boundaries.js';

describe('period boundaries', () => {
  it('uses Monday 00:00 UTC for ISO weeks', () => {
    expect(isoWeekStart('2026-09-27T23:59:59Z').toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(isoWeekStart('2026-09-21T00:00:00Z').toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
  it('returns an exclusive end boundary minus one millisecond', () => {
    expect(periodEnd(new Date('2026-09-21T00:00:00Z'), 7).toISOString()).toBe('2026-09-27T23:59:59.999Z');
  });
});
