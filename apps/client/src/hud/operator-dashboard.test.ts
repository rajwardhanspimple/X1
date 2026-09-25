import { describe, expect, it } from 'vitest';
import { emptyState, formatRate } from './operator-dashboard.js';

describe('operator dashboard helpers', () => {
  it('formats a rejection rate with a run count', () => expect(formatRate(0.125, 8)).toBe('12.5% (8 runs)'));
  it('returns an empty state for no rows', () => expect(emptyState([])).toBe('No verification runs in the last 30 days.'));
  it('does not return an empty state when rows exist', () => expect(emptyState([{ client_version: '1', device_class: 'desktop', rejection_reason: 'duplicate', total: 1, rejected: 1, rate: 1 }])).toBeNull());
});
