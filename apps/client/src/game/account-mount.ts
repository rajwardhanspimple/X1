/**
 * Account mount: wires AuthSession and AccountScreen into the running client.
 */

import { AccountScreen } from '../hud/account-screen.js';
import { AuthSession, describeAuthState } from '../net/auth-session.js';
import { backendUnavailableReason, describeUnavailable, logBackendState } from '../net/supabase.js';
import { mountProfile, type ProfileMount } from './profile-mount.js';

export interface AccountMount {
  session: AuthSession;
  isOpen(): boolean;
  dispose(): void;
}

function attachDevHelper(session: AuthSession): () => void {
  if (!import.meta.env.DEV) return () => {};
  const target = window as unknown as { rearena?: Record<string, unknown> };
  target.rearena ??= {};
  const existing = target.rearena;
  existing.account = () => {
    const state = session.getState();
    const unavailable = backendUnavailableReason();
    return {
      status: state.status,
      userId: state.userId,
      email: state.email,
      providers: state.providers,
      busy: state.busy,
      failure: state.failure,
      backend: unavailable ?? 'configured',
      summary: unavailable ? describeUnavailable(unavailable) : describeAuthState(state),
    };
  };
  return () => { delete existing.account; };
}

export function mountAccount(hudRoot: HTMLElement): AccountMount {
  logBackendState();
  const session = new AuthSession();
  const profile: ProfileMount = mountProfile(hudRoot, session);
  const screen = new AccountScreen(hudRoot, session, {
    onClose: () => screen.hide(),
    onProfile: () => profile.show(),
  });

  const menuActions = hudRoot.querySelector('.screen-menu .screen-actions');
  let line: HTMLElement | null = null;
  let link: HTMLButtonElement | null = null;
  let profileLink: HTMLButtonElement | null = null;

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
    link.addEventListener('click', () => screen.show());
    line.appendChild(link);
    profileLink = document.createElement('button');
    profileLink.type = 'button';
    profileLink.className = 'btn-quiet account-line-link';
    profileLink.textContent = 'Profile';
    profileLink.hidden = true;
    profileLink.addEventListener('click', () => profile.show());
    line.appendChild(profileLink);
    menuActions.parentElement.insertBefore(line, menuActions.nextSibling);
  } else {
    console.info('[rearena] menu actions not found; account button not mounted');
  }

  const unsubscribe = session.subscribe((state) => {
    if (!line) return;
    const textNode = line.querySelector('.account-line-text');
    if (!textNode) return;
    const unavailable = backendUnavailableReason();
    textNode.textContent = unavailable ? describeUnavailable(unavailable) : describeAuthState(state);
    if (link) link.hidden = unavailable !== null;
    if (profileLink) profileLink.hidden = unavailable !== null || (state.status !== 'guest' && state.status !== 'account');
    line.dataset.status = unavailable ? 'offline' : state.status;
  });

  const removeDevHelper = attachDevHelper(session);
  void session.start();

  return {
    session,
    isOpen: () => screen.isVisible() || profile.isOpen(),
    dispose() {
      removeDevHelper();
      unsubscribe();
      screen.dispose();
      profile.dispose();
      session.dispose();
      line?.remove();
    },
  };
}
