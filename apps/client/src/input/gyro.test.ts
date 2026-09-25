import { describe, expect, it, vi } from 'vitest';
import { GyroAimProvider } from './gyro.js';

describe('gyro permission handling', () => {
  it('keeps gyro disabled when permission is denied', async () => {
    const explain = vi.fn();
    const provider = new GyroAimProvider(vi.fn(), explain);
    const original = (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
    (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = { requestPermission: async () => 'denied' };
    expect(await provider.enable()).toBe(false);
    expect(provider.isEnabled()).toBe(false);
    expect(explain).toHaveBeenCalled();
    (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = original;
  });
});
