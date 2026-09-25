/**
 * Leaderboard mount (WO-43): the board overlay plus the buttons that open it
 * from the menu and the Result Screen.
 *
 * Self-mounting like the account panel. It listens for the run-verified event the verification mount dispatches and
 * drops its cached pages then, so a board opened right after a verified round shows the new entry.
 *
 * Racing a ghost is WO-48. Until then a picked ghost is announced as a `rearena:ghost-launch` event carrying the run,
 * map, mode and simulation version, and the board says racing is not available yet.
 */

import {
  LeaderboardScreen,
  type BoardOption,
  type GhostLaunch,
} from '../hud/leaderboard-screen.js';
import { RUN_VERIFIED_EVENT } from './verification-mount.js';
import { mountChallenge } from './challenge-mount.js';

export const GHOST_LAUNCH_EVENT = 'rearena:ghost-launch';

export interface LeaderboardMount {
  open(): void;
  isOpen(): boolean;
  dispose(): void;
}

const BUTTON_HOSTS = ['.screen-menu .screen-actions', '.screen-results .screen-actions'];

export function mountLeaderboard(
  hudRoot: HTMLElement,
  options: { maps: readonly BoardOption[]; modes: readonly BoardOption[] },
): LeaderboardMount {
  const screen: LeaderboardScreen = new LeaderboardScreen(hudRoot, {
    maps: options.maps,
    modes: options.modes,
    onGhost(launch: GhostLaunch) {
      window.dispatchEvent(new CustomEvent<GhostLaunch>(GHOST_LAUNCH_EVENT, { detail: launch }));
      screen.setNote(
        `Ghost races are not available yet. ${launch.playerName}'s run (score ${launch.score.toLocaleString()}) is kept for when they are.`,
      );
    },
  });

  const buttons: HTMLButtonElement[] = [];
  for (const selector of BUTTON_HOSTS) {
    const host = hudRoot.querySelector<HTMLElement>(selector);
    if (!host) {
      console.info(`[rearena] ${selector} not found; leaderboard button not mounted`);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'screen-button';
    button.textContent = 'Leaderboards';
    // No data-action, so the screens' delegated listener ignores it and opening a
    // board never changes round state.
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      screen.open();
    });
    host.appendChild(button);
    buttons.push(button);
  }

  const onVerified = (): void => screen.invalidate();
  window.addEventListener(RUN_VERIFIED_EVENT, onVerified);
  const challenge = mountChallenge(hudRoot);

  return {
    open: () => screen.open(),
    isOpen: () => screen.isOpen(),
    dispose() {
      window.removeEventListener(RUN_VERIFIED_EVENT, onVerified);
      for (const button of buttons) button.remove();
      challenge.dispose();
      screen.dispose();
    },
  };
}
