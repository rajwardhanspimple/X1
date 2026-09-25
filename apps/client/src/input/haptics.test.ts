import { describe, expect, it, vi } from 'vitest';
import { HapticsBridge } from './haptics.js';

describe('haptics fallback', () => {
  it('does nothing when vibration is unavailable', () => {
    const haptics = new HapticsBridge({});
    expect(haptics.isSupported()).toBe(false);
    expect(() => haptics.press()).not.toThrow();
  });
  it('uses vibration when available', () => {
    const vibrate = vi.fn(() => true);
    const haptics = new HapticsBridge({ vibrate });
    haptics.press();
    expect(vibrate).toHaveBeenCalledWith(12);
  });
});
