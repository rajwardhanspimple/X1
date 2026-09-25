import { describeAuthState, describeMethod, SIGN_IN_METHODS, type AuthSession, type AuthState, type SignInMethod } from '../net/auth-session.js';
import { backendUnavailableReason, describeUnavailable } from '../net/supabase.js';
import { renderRecentRuns } from './recent-runs.js';

 type Panel = 'overview' | 'upgrade' | 'signin' | 'confirm-switch';
const CONFIRM_WORD = 'SWITCH';

export interface AccountScreenCallbacks { onClose(): void; onProfile(): void; }

export class AccountScreen {
  private readonly root: HTMLElement;
  private panel: Panel = 'overview';
  private method: SignInMethod = 'password';
  private state: AuthState;
  private unsubscribe: () => void;
  private carriedEmail = '';

  constructor(parent: HTMLElement, private readonly auth: AuthSession, private readonly callbacks: AccountScreenCallbacks) {
    this.root = document.createElement('div'); this.root.className = 'screen account-screen'; this.root.hidden = true; parent.appendChild(this.root);
    this.state = auth.getState();
    this.unsubscribe = auth.subscribe((state) => {
      const previous = this.state; this.state = state;
      if (state.failure?.kind === 'identity-taken' && previous.failure?.kind !== 'identity-taken' && this.panel === 'upgrade') this.panel = 'signin';
      if (!this.root.hidden) this.render();
    });
  }
  show(): void { this.panel = 'overview'; this.root.hidden = false; this.render(); }
  hide(): void { this.root.hidden = true; }
  isVisible(): boolean { return !this.root.hidden; }
  dispose(): void { this.unsubscribe(); this.root.remove(); }
  private esc(text: string): string { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
  private failureHtml(): string { const f = this.state.failure; if (!f) return ''; const retry = f.retryable ? '<button type="button" data-act="retry" class="btn-secondary">Try again</button>' : ''; return `<div class="account-error" role="alert"><p>${this.esc(f.message)}</p>${retry}</div>`; }
  private render(): void {
    if (this.panel === 'overview') return this.renderOverview();
    if (this.panel === 'upgrade') return this.renderUpgrade();
    if (this.panel === 'signin') return this.renderSignIn();
    this.renderConfirmSwitch();
  }
  private renderOverview(): void {
    const unavailable = backendUnavailableReason(); const status = unavailable ? describeUnavailable(unavailable) : describeAuthState(this.state);
    let actions = '';
    if (!unavailable && this.state.status === 'guest') actions = '<button type="button" data-act="upgrade" class="btn-primary">Save my progress</button><button type="button" data-act="signin" class="btn-secondary">I already have an account</button>';
    else if (!unavailable && this.state.status === 'account') actions = '<button type="button" data-act="profile" class="btn-primary">Profile</button><button type="button" data-act="signout" class="btn-secondary">Sign out</button>';
    else if (!unavailable && this.state.status === 'offline') actions = '<button type="button" data-act="guest" class="btn-primary">Play as guest</button><button type="button" data-act="signin" class="btn-secondary">Sign in</button>';
    const providers = this.state.providers.length ? `<p class="account-providers">Linked: ${this.esc(this.state.providers.join(', '))}</p>` : '';
    const recent = !unavailable && (this.state.status === 'guest' || this.state.status === 'account') ? '<div class="recent-runs"></div>' : '';
    this.root.innerHTML = `<div class="screen-panel"><h2>Account</h2><p class="account-status">${this.esc(status)}</p>${providers}${this.failureHtml()}${recent}<div class="screen-actions">${actions}</div><button type="button" data-act="close" class="btn-quiet">Back</button></div>`;
    this.bind(); const host = this.root.querySelector<HTMLElement>('.recent-runs'); if (host) void renderRecentRuns(host);
  }
  private methodTabs(): string { return SIGN_IN_METHODS.map((m) => `<button type="button" data-method="${m}" class="account-tab${m === this.method ? ' is-active' : ''}">${this.esc(describeMethod(m))}</button>`).join(''); }
  private renderUpgrade(): void { const form = this.method === 'password' ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label><label>Password<input type="password" data-field="password" autocomplete="new-password"></label><button type="button" data-act="do-upgrade" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Save progress</button>` : this.method === 'magic-link' ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label><button type="button" data-act="do-upgrade" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Send me a link</button>` : `<button type="button" data-act="do-upgrade" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Continue with ${this.esc(describeMethod(this.method))}</button>`; this.root.innerHTML = `<div class="screen-panel"><h2>Save your progress</h2><p class="account-note">Your scores and unlocks stay exactly as they are. This only adds a way to sign back in.</p><div class="account-tabs">${this.methodTabs()}</div><div class="account-form">${form}</div>${this.failureHtml()}<button type="button" data-act="overview" class="btn-quiet">Back</button></div>`; this.bind(); }
  private renderSignIn(): void { const form = this.method === 'password' ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label><label>Password<input type="password" data-field="password" autocomplete="current-password"></label><button type="button" data-act="do-signin" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Sign in</button>` : this.method === 'magic-link' ? `<label>Email<input type="email" data-field="email" autocomplete="email" value="${this.esc(this.carriedEmail)}"></label><button type="button" data-act="do-signin" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Send me a link</button>` : `<button type="button" data-act="do-signin" class="btn-primary"${this.state.busy ? ' disabled' : ''}>Continue with ${this.esc(describeMethod(this.method))}</button>`; const warning = this.state.status === 'guest' ? '<p class="account-warn">Signing in to a different account will leave this guest progress behind.</p>' : ''; this.root.innerHTML = `<div class="screen-panel"><h2>Sign in</h2>${warning}<div class="account-tabs">${this.methodTabs()}</div><div class="account-form">${form}</div>${this.failureHtml()}<button type="button" data-act="overview" class="btn-quiet">Back</button></div>`; this.bind(); }
  private renderConfirmSwitch(): void { this.root.innerHTML = `<div class="screen-panel"><h2>Leave this progress behind?</h2><p class="account-warn">You are playing as a guest. Signing in to another account will leave these scores and unlocks behind.</p><label>Type ${CONFIRM_WORD} to continue<input type="text" data-field="confirm" autocomplete="off"></label><div class="screen-actions"><button type="button" data-act="confirm-switch" class="btn-danger">Sign in anyway</button><button type="button" data-act="overview" class="btn-secondary">Keep my progress</button></div></div>`; this.bind(); }
  private field(name: string): string { return this.root.querySelector<HTMLInputElement>(`[data-field="${name}"]`)?.value.trim() ?? ''; }
  private bind(): void { for (const tab of this.root.querySelectorAll<HTMLElement>('[data-method]')) tab.addEventListener('click', () => { this.method = tab.dataset.method as SignInMethod; const email = this.field('email'); if (email) this.carriedEmail = email; this.render(); }); for (const button of this.root.querySelectorAll<HTMLElement>('[data-act]')) button.addEventListener('click', () => void this.act(button.dataset.act ?? '')); }
  private async act(action: string): Promise<void> {
    if (action === 'close') return this.callbacks.onClose();
    if (action === 'profile') return this.callbacks.onProfile();
    if (action === 'overview') { this.panel = 'overview'; return this.render(); }
    if (action === 'upgrade') { this.panel = 'upgrade'; return this.render(); }
    if (action === 'signin') { this.panel = this.state.status === 'guest' ? 'confirm-switch' : 'signin'; return this.render(); }
    if (action === 'confirm-switch') { if (this.field('confirm').toUpperCase() === CONFIRM_WORD) { this.panel = 'signin'; this.render(); } return; }
    if (action === 'retry') return void (await this.auth.retry());
    if (action === 'guest') return void (await this.auth.playAsGuest());
    if (action === 'signout') { await this.auth.signOut(); this.panel = 'overview'; return this.render(); }
    if (action === 'do-upgrade') { const email = this.field('email'); this.carriedEmail = email; if (this.method === 'password') await this.auth.upgradeWithPassword(email, this.field('password')); else if (this.method === 'magic-link') await this.auth.upgradeWithMagicLink(email); else await this.auth.upgradeWithProvider(this.method); if (!this.state.failure && this.state.status === 'account') this.panel = 'overview'; return this.render(); }
    if (action === 'do-signin') { const email = this.field('email'); this.carriedEmail = email; if (this.method === 'password') await this.auth.signInWithPassword(email, this.field('password')); else if (this.method === 'magic-link') await this.auth.upgradeWithMagicLink(email); else await this.auth.signInWithProvider(this.method); if (!this.state.failure && this.state.status === 'account') this.panel = 'overview'; return this.render(); }
  }
}
