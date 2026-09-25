import { describe, expect, it } from 'vitest';
import { Buttons } from '@rearena/protocol';
import { withSlide } from './bindings.js';

describe('slide binding', () => {
  it('adds Slide when crouch and sprint are both held', () => {
    const buttons = withSlide(Buttons.Crouch | Buttons.Sprint);
    expect(buttons & Buttons.Slide).toBe(Buttons.Slide);
    // The original bits stay, so the sim still sees crouch.
    expect(buttons & Buttons.Crouch).toBe(Buttons.Crouch);
  });

  it('does not add Slide for crouch alone or sprint alone', () => {
    expect(withSlide(Buttons.Crouch) & Buttons.Slide).toBe(0);
    expect(withSlide(Buttons.Sprint) & Buttons.Slide).toBe(0);
    expect(withSlide(Buttons.None)).toBe(Buttons.None);
  });

  it('keeps unrelated buttons', () => {
    const buttons = withSlide(Buttons.Crouch | Buttons.Sprint | Buttons.Fire);
    expect(buttons & Buttons.Fire).toBe(Buttons.Fire);
  });
});
