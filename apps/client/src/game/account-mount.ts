/**
 * Account mount: wires AuthSession and AccountScreen into the running client.
 *
 * ## Why this is self-mounting
 *
 * The obvious alternative is another `ScreenAction`, but that would mean touching the action union, the menu
 * builder, the round-orchestrator state machine and the dispatch switch in main, for a panel that has nothing to
 * do with round state. The account screen does not pause a round, resume one, or change a run; threading it
 * through the round state machine would add coupling for no benefit.
 *
 * So this module owns its own button, its own visibility, and its own lifecycle. main.ts calls it once.
 *
 * ## The DOM dependency is real and handled
 *
 * The button is inserted into the menu's existing actions container, found by selector. That is a genuine
 * coupling to screens.ts markup, so a missing container logs and returns rather than throwing: a menu without an
 * account button is a much smaller problem than a client that fails to boot.
 */

import { AccountScreen } from '../hud/account-screen.js';
import { AuthSession, describeAuthState } from '../net/auth-session.js';
import { backendUnavailableReason, describeUnavailable, logBackendState } from '../net/supabase.js';

export interface AccountMount {
  session: AuthSession;
  /** True while the account panel is covering the screen, so input can be ignored. */
  isOpen(): boolean;
  dispose(): void;
}

/**
 * Mount the account surface.
 *
 * `hudRoot` is the element the screens are already inside, so the panel stacks with them. The session starts
 * immediately and does not block: the returned object is usable before a session exists.
 */
export function mountAccount(hudRoot: HTMLElement): AccountMount {
  logBackendState();

  const session = new AuthSession();

  const screen = new AccountScreen(hudRoot, session, {
    onClose() {
      screen.hide();
    },
  });

  /*
   * A status line plus a link, placed after the menu's action buttons. Status rather than a prompt: a guest needs
   * to know their progress is not yet safe, but being asked to register before playing is the most reliable way
   * to lose them. The results screen is where an upgrade is worth suggesting.
   */
  const menuActions = hudRoot.querySelector('.screen-menu .screen-actions');
  let line: HTMLElement | null = null;
  let link: HTMLButtonElement | null = null;

  if (menuActions?.parentElement) {
    line = document.createElement('p');
    line.className = 'account-line';

    const text = document.createElement('span');
    text.className = 'account-line-text';
    line.appendChild(text);

    link = document.createElement('button');
    link.type = 'button';
    link.className = 'btn-quiet account-line-link';
    link.textContent = 'Account';
    link.addEventListener('click', () => {
      screen.show();
    });
    line.appendChild(link);

    menuActions.parentElement.insertBefore(line, menuActions.nextSibling);
  } else {
    console.info('[rearena] menu actions not found; account button not mounted');
  }

  const unsubscribe = session.subscribe((state) => {
    if (!line) return;
    const textNode = line.querySelector('.account-line-text');
    if (!textNode) return;

    const unavailable = backendUnavailableReason();
    textNode.textContent = unavailable
      ? describeUnavailable(unavailable)
      : describeAuthState(state);

    // With no backend there is no account to open, so the link would be a dead end.
    if (link) link.hidden = unavailable !== null;

    // Mark a guest so the style can draw attention without a modal.
    line.dataset.status = unavailable ? 'offline' : state.status;
  });

  // Fire and forget. Nothing downstream waits on this, which is what keeps a slow network out of the boot path.
  void session.start();

  return {
    session,
    isOpen: () => screen.isVisible(),
    dispose() {
      unsubscribe();
      screen.dispose();
      session.dispose();
      line?.remove();
    },
  };
}
