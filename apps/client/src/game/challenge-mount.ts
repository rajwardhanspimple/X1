import { ChallengeScreen, type ChallengeStartConfig } from '../hud/challenge-screen.js';

export const CHALLENGE_START_EVENT = 'rearena:challenge-start';

export interface ChallengeMount {
  open(): void;
  isOpen(): boolean;
  dispose(): void;
}

const BUTTON_HOSTS = ['.screen-menu .screen-actions', '.screen-results .screen-actions'];

export function mountChallenge(hudRoot: HTMLElement): ChallengeMount {
  const screen = new ChallengeScreen(hudRoot, {
    onStart(attempt: ChallengeStartConfig) {
      window.dispatchEvent(
        new CustomEvent<ChallengeStartConfig>(CHALLENGE_START_EVENT, { detail: attempt }),
      );
    },
  });
  const buttons: HTMLButtonElement[] = [];
  for (const selector of BUTTON_HOSTS) {
    const host = hudRoot.querySelector<HTMLElement>(selector);
    if (!host) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'screen-button';
    button.textContent = 'Daily Challenge';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      screen.open();
    });
    host.append(button);
    buttons.push(button);
  }
  return {
    open: () => screen.open(),
    isOpen: () => screen.isOpen(),
    dispose() {
      for (const button of buttons) button.remove();
      screen.dispose();
    },
  };
}
