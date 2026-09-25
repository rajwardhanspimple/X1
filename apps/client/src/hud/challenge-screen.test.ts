import { describe, expect, it } from 'vitest';
import { deriveChallengeAvailability, formatChallengeCountdown } from './challenge-screen.js';

describe('daily challenge countdown', () => {
  it('formats a countdown with days when needed', () => {
    expect(formatChallengeCountdown(90061000)).toBe('1d 01h');
    expect(formatChallengeCountdown(61000)).toBe('00:01:01');
  });

  it('never formats a negative countdown', () => {
    expect(formatChallengeCountdown(-1)).toBe('00:00:00');
  });
});

describe('daily challenge availability', () => {
  const challenge = { attempt_used: false, opens_at: '2026-09-25T00:00:00Z', closes_at: '2026-09-26T00:00:00Z' };
  it('is available inside the authoritative window', () => expect(deriveChallengeAvailability(challenge, Date.parse('2026-09-25T12:00:00Z'))).toBe('available'));
  it('is used after the attempt starts', () => expect(deriveChallengeAvailability({ ...challenge, attempt_used: true }, Date.parse('2026-09-25T12:00:00Z'))).toBe('used'));
  it('is closed outside the UTC window', () => expect(deriveChallengeAvailability(challenge, Date.parse('2026-09-26T00:00:00Z'))).toBe('closed'));
});
