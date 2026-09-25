import { afterEach, describe, expect, it, vi } from 'vitest';
import { GyroAimProvider } from './gyro.js';

describe('gyro permission handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps gyro disabled when permission is denied', async () => {
    const explain = vi.fn();
    const requestPermission = vi.fn(async () => 'denied' as const);
    vi.stubGlobal('window', {
      DeviceOrientationEvent: { requestPermission },
    });
    const provider = new GyroAimProvider(vi.fn(), explain);

    expect(await provider.enable()).toBe(false);
    expect(provider.isEnabled()).toBe(false);
    expect(explain).toHaveBeenCalled();
  });
});
