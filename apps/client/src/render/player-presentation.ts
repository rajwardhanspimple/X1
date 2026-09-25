/**
 * Player presentation state: what the camera, weapon view and HUD need to know about the player's body
 * that is not in their own update inputs.
 *
 * SimulationHost writes it on every snapshot and clears it on dispose. Readers only read. It is a
 * module-level object, rather than another argument threaded through main.ts, because three renderers
 * read it and none of them feed anything back: it is display state, not game state.
 *
 * Nothing here reaches the simulation. The simulation owns the down timer and the slide timer; this is
 * a copy of them for drawing.
 */

export interface PlayerPresentation {
  /** Ticks remaining in Player Down, from the newest snapshot. 0 when alive. */
  downTicks: number;
  /** True while the simulation has the player in a slide. */
  sliding: boolean;
}

export const playerPresentation: PlayerPresentation = { downTicks: 0, sliding: false };

export function setPlayerPresentation(downTicks: number, sliding: boolean): void {
  playerPresentation.downTicks = downTicks;
  playerPresentation.sliding = sliding;
}

export function resetPlayerPresentation(): void {
  playerPresentation.downTicks = 0;
  playerPresentation.sliding = false;
}
