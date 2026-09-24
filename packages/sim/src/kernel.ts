/**
 * Bump on any change that can alter an outcome for the same inputs. Leaderboards, daily
 * challenges and ghosts are keyed on it, and the golden replay test fails until the fixtures
 * are regenerated.
 *
 * 1 initial. 2 movement and collision (WO-36). 3 weapons, enemies, waves, score (WO-39/42/45).
 * 4 gamepad aim assist (WO-23): a frame carrying the AimAssist flag now changes the resulting aim.
 * 5 enemy separation and no firing at a downed player (WO-42): positions and shot timing differ.
 * 6 serialised headshot tally and telegraphing flag, and the telegraph now precedes the shot
 *   (WO-45, WO-42): shot timing shifts by the telegraph length on every engagement.
 * 7 player spawns moved off the perimeter container rows (layout.ts): every run starts somewhere else.
 * 8 slide move (Buttons.Slide): sprint + crouch while moving produces a brief boost.
 */
export const SIM_VERSION = 8;
