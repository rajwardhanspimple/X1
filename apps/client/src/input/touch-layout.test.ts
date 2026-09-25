import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampLayout,
  DEFAULT_TOUCH_LAYOUT,
  DEFAULT_TOUCH_PREFERENCES,
  loadTouchState,
  saveTouchState,
} from './touch-layout';

describe('touch layout persistence', () => {
  const area = { width: 1000, height: 500 };

  beforeEach(() => {
    localStorage.clear();
  });

  it('clamps positions and preserves the 44px minimum', () => {
    const layout = clampLayout(
      {
        fire: { ...DEFAULT_TOUCH_LAYOUT.fire, x: 2, y: -1, width: 0.001, height: 0.001 },
      },
      area,
    );
    expect(layout.fire.x).toBeLessThanOrEqual(1 - layout.fire.width);
    expect(layout.fire.y).toBe(0);
    expect(layout.fire.width * area.width).toBeGreaterThanOrEqual(64);
  });

  it('round trips layout and preferences through local storage', () => {
    const state = {
      layout: DEFAULT_TOUCH_LAYOUT,
      preferences: { ...DEFAULT_TOUCH_PREFERENCES, gyroEnabled: true },
    };
    saveTouchState(state, area);
    expect(loadTouchState(area).preferences.gyroEnabled).toBe(true);
    expect(loadTouchState(area).layout.fire).toEqual(DEFAULT_TOUCH_LAYOUT.fire);
  });
});
