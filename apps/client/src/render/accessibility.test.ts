import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  getAccessibilitySettings,
  paletteColours,
  relativeLuminance,
  setAccessibilitySettings,
} from './accessibility.js';

describe('accessibility settings', () => {
  it('uses accessible defaults', () => {
    const settings = getAccessibilitySettings();
    expect(settings.palette).toBe('standard');
    expect(settings.reduceMotion).toBe(false);
    expect(settings.hudScale).toBe(1);
  });

  it('maps all supported colour-blind palettes to distinct semantic colours', () => {
    for (const palette of ['standard', 'deuteranopia', 'protanopia', 'tritanopia'] as const) {
      const colours = paletteColours(palette);
      expect(colours.enemy).toMatch(/^#[0-9a-f]{6}$/i);
      expect(colours.friendly).not.toBe(colours.enemy);
      expect(colours.objective).not.toBe(colours.enemy);
    }
  });

  it('clamps persisted presentation values and keeps reduce motion explicit', () => {
    setAccessibilitySettings({ hudScale: 10, hudOpacity: 0, reduceMotion: true });
    const settings = getAccessibilitySettings();
    expect(settings.hudScale).toBe(1.5);
    expect(settings.hudOpacity).toBe(0.5);
    expect(settings.reduceMotion).toBe(true);
    setAccessibilitySettings({ hudScale: 1, hudOpacity: 1, reduceMotion: false });
  });
});

describe('contrast maths', () => {
  it('returns known WCAG values', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
    expect(relativeLuminance('#000000')).toBeCloseTo(0);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});
