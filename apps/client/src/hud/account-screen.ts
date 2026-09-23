/**
 * Account screen: guest upgrade, sign-in, and sign-out.
 *
 * Plain DOM, matching the rest of the HUD and screens. No framework: the surface is four buttons and two fields,
 * and adding React here would mean shipping it for this alone.
 *
 * ## Two decisions worth stating
 *
 * **Signing in to an existing account asks for typed confirmation.** It replaces the current session, so any
 * guest progress not already on that account is gone. A dialog with a Confirm button is dismissed reflexively;
 * typing the word is proportionate to something irreversible.
 *
 * **A duplicate identity switches to sign-in with the email prefilled** instead of showing an error beside a
 * retry button. Retrying cannot succeed, and AC-ACC-002.4 asks the flow to direct the player, not just inform
 * them.
 *
 * Note what is absent: nothing here prompts for an upgrade. That prompt belongs after a finished round, because
 * asking for an account before someone knows whether they like the game is the most reliable way to lose them.
 */

import {
  describeAuthState,
  describeMethod,
  SIGN_IN_METHODS,
  type AuthSession,
  type AuthState,
  type SignInMethod,
} from '../net/auth-session.js';
import { backendUnavailableReason, describeUnavailable } from '../net/supabase.js';

/** Which panel the screen is showing. */
type Panel = 'overview' | 'upgrade' | 'signin' | 'confirm-switch';

const CONFIRM_WORD = 'SWITCH';

export interface AccountScreenCallbacks {
  /** Close and return to wherever the player came from. */
  onClose(): void;
}

export class AccountScreen {
  private readonly root: HTMLElement;
  private panel: Panel = 'overview';
  private method: SignInMethod = 'password';
  private state: AuthState;
  private unsubscribe: () => void;
  /** Email carried from a failed upgrade into the sign-in panel. */
  private carriedEmail = '';

  constructor(
    parent: HTMLElement,
    private readonly auth: AuthSession,
    private readonly callbacks: AccountScreenCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'screen account-screen';
    this.root.hidden = true;
    parent.appendChild(this.root);

    this.state = auth.getState();
    this.unsubscribe = auth.subscribe((state) => {
      const previous = this.state;
      this.state = state;

      /*
       * A duplicate identity means the upgrade can never succeed, so move the player to the flow that can. Done
       * here rather than at the call site so it applies however the upgrade was started.
       */
      if (
        state.failure?.kind === 'identity-taken' &&
        previous.failure?.kind !== 'identity-taken' &&
        this.panel === 'upgrade'
      ) {
        this.panel = 'signin';
      }

      if (!this.root.hidden) this.render();
    });
  }

  show(): void {
    this.panel = 'overview';
    this.root.hidden = false;
    this.render();
  }

  hide(): void {
    this.root.hidden = true;
  }

  isVisible(): boolean {
    return !this.root.hidden;
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
  }

  private render(): void {
    switch (this.panel) {
      case 'overview':
        this.renderOverview();
        break;
      case 'upgrade':
        this.renderUpgrade();
        break;
      case 'signin':
        this.renderSignIn();
        break;
      case 'confirm-switch':
        this.renderConfirmSwitch();
        break;
    }
  }

  /** Escape text for innerHTML. Display names and emails are player-controlled. */
  private esc(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private failureHtml(): string {
    const failure = this.state.failure;
    if (!failure) return '';
    const retry = failure.retryable
      ? '<button type="button" data-act="retry" class="btn-secondary">Try again</button>'
      : '';
    return `<div class="account-error" role="alert"><p>${this.esc(failure.message)}</p>${retry}</div>`;
  }

  private renderOverview(): void {
    const unavailable = backendUnavailableReason();
    const status = unavailable ? describeUnavailable(unavailable) : describeAuthState(this.state);

    let actions = '';
    if (unavailable) {
      // Nothing to offer: no backend means no account. Say so plainly rather than showing dead buttons.
      actions = '';
    } else if (this.state.status === 'guest') {
      actions = `
        <button type="button" data-act="upgrade" class="btn-primary">Save my progress</button>
        <button type="button" data-act="signin" class="btn-secondary">I already have an account</button>`;
    } else if (this.state.status === 'account') {
      actions = `
        <button type="button" data-act="signout" class="btn-secondary">Sign out</button>`;
    } else if (this.state.status === 'offline') {
      actions = `
        <button type="button" data-act="guest" class="btn-primary">Play as guest</button>
        <button type="button" data-act="signin" class="btn-secondary">Sign in</button>`;
    }

    const providers =
      this.state.providers.length > 0
        ? `<p class="account-providers">Linked: ${this.esc(this.state.providers.join(', '))}</p>`
        : '';

    this.root.innerHTML = `
      <div class="screen-panel">
        <h2>Account</h2>
        <p class="account-status">${this.esc(status)}</p>
        ${providers}
        ${this.failureHtml()}
        <div class="screen-actions">${actions}</div>
        <button type="button" data-act="close" class="btn-quiet">Back</button>
      </div>`;
    this.bind();
  }

  private methodTabs(): string {
    return SIGN_IN_METHODS.map(
      (m) =>
        `<button type="button" data-method="${m}" class="account-tab${
          m === this.method ? ' is-active' : ''
        }">${this.esc(describeMethod(m))}</button>`,
    ).join('');
  }

  private renderUpgrade(): void {
    // AC-ACC-002.1: all four methods are offered.
    const form =
      this.method === 'password'
        ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label>
           <label>Password<input type="password" data-field="password" autocomplete="new-password"></label>
           <button type="button" data-act="do-upgrade" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Save progress</button>`
        : this.method === 'magic-link'
          ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label>
             <button type="button" data-act="do-upgrade" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Send me a link</button>`
          : `<button type="button" data-act="do-upgrade" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Continue with ${this.esc(describeMethod(this.method))}</button>`;

    this.root.innerHTML = `
      <div class="screen-panel">
        <h2>Save your progress</h2>
        <p class="account-note">Your scores and unlocks stay exactly as they are. This only adds a way to sign back in.</p>
        <div class="account-tabs">${this.methodTabs()}</div>
        <div class="account-form">${form}</div>
        ${this.failureHtml()}
        <button type="button" data-act="overview" class="btn-quiet">Back</button>
      </div>`;
    this.bind();
  }

  private renderSignIn(): void {
    const form =
      this.method === 'password'
        ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label>
           <label>Password<input type="password" data-field="password" autocomplete="current-password"></label>
           <button type="button" data-act="do-signin" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Sign in</button>`
        : this.method === 'magic-link'
          ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label>
             <button type="button" data-act="do-signin" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Send me a link</button>`
          : `<button type="button" data-act="do-signin" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Continue with ${this.esc(describeMethod(this.method))}</button>`;

    /*
     * The warning appears only for a guest, because only a guest has unsaved progress to lose. An offline player
     * signing in has nothing at stake.
     */
    const warning =
      this.state.status === 'guest'
        ? '<p class="account-warn">Signing in to a different account will leave this guest progress behind.</p>'
        : '';

    this.root.innerHTML = `
      <div class="screen-panel">
        <h2>Sign in</h2>
        ${warning}
        <div class="account-tabs">${this.methodTabs()}</div>
        <div class="account-form">${form}</div>
        ${this.failureHtml()}
        <button type="button" data-act="overview" class="btn-quiet">Back</button>
      </div>`;
    this.bind();
  }

  private renderConfirmSwitch(): void {
    this.root.innerHTML = `
      <div class="screen-panel">
        <h2>Leave this progress behind?</h2>
        <p class="account-warn">You are playing as a guest. Signing in to another account will abandon the scores and unlocks on this device. They cannot be recovered.</p>
        <p class="account-note">To keep them instead, go back and choose "Save my progress".</p>
        <label>Type ${CONFIRM_WORD} to continue<input type="text" data-field="confirm" autocomplete="off"></label>
        <div class="screen-actions">
          <button type="button" data-act="confirm-switch" class="btn-danger">Sign in anyway</button>
          <button type="button" data-act="overview" class="btn-secondary">Keep my progress</button>
        </div>
      </div>`;
    this.bind();
  }

  private field(name: string): string {
    const input = this.root.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
    return input?.value.trim() ?? '';
  }

  private bind(): void {
    for (const tab of this.root.querySelectorAll<HTMLElement>('[data-method]')) {
      tab.addEventListener('click', () => {
        this.method = tab.dataset.method as SignInMethod;
        // Keep whatever was typed when switching tabs: retyping an email is a pointless irritation.
        const typed = this.field('email');
        if (typed) this.carriedEmail = typed;
        this.render();
      });
    }

    for (const button of this.root.querySelectorAll<HTMLElement>('[data-act]')) {
      button.addEventListener('click', () => void this.act(button.dataset.act ?? ''));
    }
  }

  private async act(action: string): Promise<void> {
    switch (action) {
      case 'close':
        this.callbacks.onClose();
        return;

      case 'overview':
        this.panel = 'overview';
        this.render();
        return;

      case 'upgrade':
        this.panel = 'upgrade';
        this.render();
        return;

      case 'signin':
        // A guest has something to lose, so confirm first. Anyone else goes straight in.
        this.panel = this.state.status === 'guest' ? 'confirm-switch' : 'signin';
        this.render();
        return;

      case 'confirm-switch': {
        if (this.field('confirm').toUpperCase() !== CONFIRM_WORD) {
          // Silent: the label already says what to type, and an error message here would be scolding.
          return;
        }
        this.panel = 'signin';
        this.render();
        return;
      }

      case 'retry':
        await this.auth.retry();
        return;

      case 'guest':
        await this.auth.playAsGuest();
        return;

      case 'signout':
        await this.auth.signOut();
        this.panel = 'overview';
        this.render();
        return;

      case 'do-upgrade': {
        const email = this.field('email');
        this.carriedEmail = email;
        if (this.method === 'password') {
          await this.auth.upgradeWithPassword(email, this.field('password'));
        } else if (this.method === 'magic-link') {
          await this.auth.upgradeWithMagicLink(email);
        } else {
          await this.auth.upgradeWithProvider(this.method);
        }
        // Success closes the panel; a failure leaves it open with the message from state.
        if (!this.state.failure && this.state.status === 'account') this.panel = 'overview';
        this.render();
        return;
      }

      case 'do-signin': {
        const email = this.field('email');
        this.carriedEmail = email;
        if (this.method === 'password') {
          await this.auth.signInWithPassword(email, this.field('password'));
        } else if (this.method === 'magic-link') {
          await this.auth.upgradeWithMagicLink(email);
        } else {
          await this.auth.signInWithProvider(this.method);
        }
        if (!this.state.failure && this.state.status === 'account') this.panel = 'overview';
        this.render();
        return;
      }
    }
  }
}
