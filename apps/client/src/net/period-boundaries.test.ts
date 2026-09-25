import { describe, expect, it } from 'vitest';
import { isoWeekStart, periodEnd } from './period-boundaries.js';

describe('period boundaries', () => {
  it('maps Sunday to the preceding Monday at 00:00 UTC', () => {
    expect(isoWeekStart(new Date('2026-09-27T18:30:00.000Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
  it('keeps Monday 00:00 UTC in the same ISO week', () => {
    expect(isoWeekStart(new Date('2026-09-21T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
  it('ends a seven-day period on Sunday at 23:59:59.999 UTC', () => {
    expect(periodEnd(new Date('2026-09-21T00:00:00.000Z'), 7).toISOString()).toBe(
      '2026-09-27T23:59:59.999Z',
    );
  });
});
