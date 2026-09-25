import { supabase } from '../net/supabase.js';
import type { AuthSession } from '../net/auth-session.js';

interface ProfileData {
  playerId: string;
  displayName: string;
  avatarId: string;
  country: string | null;
  level: number;
  hiddenFromBoards: boolean;
  bestScores: Array<{ mapId: string; modeId: string; score: number }>;
  medalCount: number;
}

const AVATARS = [
  'default',
  'avatar_01',
  'avatar_02',
  'avatar_03',
  'avatar_04',
  'avatar_05',
  'avatar_06',
  'avatar_07',
];

export interface ProfileScreenCallbacks {
  onClose(): void;
}

export class ProfileScreen {
  private readonly root: HTMLElement;
  private data: ProfileData | null = null;
  private message = '';
  private busy = false;

  constructor(
    parent: HTMLElement,
    private readonly auth: AuthSession,
    private readonly callbacks: ProfileScreenCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'screen profile-screen';
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  show(): void {
    this.root.hidden = false;
    this.message = '';
    this.render();
    void this.load();
  }
  hide(): void {
    this.root.hidden = true;
  }
  isVisible(): boolean {
    return !this.root.hidden;
  }
  dispose(): void {
    this.root.remove();
  }

  private esc(value: unknown): string {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
  }
  private field(name: string): string {
    return this.root.querySelector<HTMLInputElement>(`[data-field="${name}"]`)?.value.trim() ?? '';
  }

  private render(): void {
    const state = this.auth.getState();
    if (!supabase || !state.userId) {
      this.root.innerHTML =
        '<div class="screen-panel"><h2>Profile</h2><p class="account-note">Sign in to manage your profile.</p><button type="button" data-act="close" class="btn-quiet">Back</button></div>';
      this.bind();
      return;
    }
    if (!this.data) {
      this.root.innerHTML = `<div class="screen-panel"><h2>Profile</h2><p class="account-note">Loading profile...</p>${this.messageHtml()}<button type="button" data-act="close" class="btn-quiet">Back</button></div>`;
      this.bind();
      return;
    }
    const p = this.data;
    const scores = p.bestScores.length
      ? p.bestScores
          .map(
            (s) =>
              `<li>${this.esc(s.mapId)} / ${this.esc(s.modeId)}: <strong>${s.score.toLocaleString()}</strong></li>`,
          )
          .join('')
      : '<li>No verified scores yet.</li>';
    this.root.innerHTML = `<div class="screen-panel"><h2>Profile</h2><div class="profile-summary"><strong>${this.esc(p.displayName)}</strong><span>Level ${p.level}</span><span>${p.medalCount} medals</span></div>
      <label>Display name<input data-field="displayName" maxlength="16" value="${this.esc(p.displayName)}"></label>
      <label>Avatar<select data-field="avatar">${AVATARS.map((a) => `<option value="${a}"${a === p.avatarId ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
      <label>Country flag (optional)<input data-field="country" maxlength="2" value="${this.esc(p.country ?? '')}" placeholder="None"></label>
      <label class="profile-check"><input type="checkbox" data-field="hidden"${p.hiddenFromBoards ? ' checked' : ''}> Hide my entries from leaderboards</label>
      <button type="button" data-act="save" class="btn-primary"${this.busy ? ' disabled' : ''}>Save profile</button>
      <h3>Best scores</h3><ul class="profile-scores">${scores}</ul>
      <details><summary>Report a player</summary><label>Player ID<input data-field="target" placeholder="Player ID"></label><label>Reason<textarea data-field="reason" maxlength="500"></textarea></label><button type="button" data-act="report" class="btn-secondary">Submit report</button></details>
      <details class="profile-delete"><summary>Delete account</summary><p class="account-warn">This permanently removes your full account, profile, cloud progress, and linked results.</p><label>Type DELETE MY ACCOUNT to confirm<input data-field="confirm"></label><button type="button" data-act="delete" class="btn-danger">Delete permanently</button></details>
      ${this.messageHtml()}<button type="button" data-act="close" class="btn-quiet">Back</button></div>`;
    this.bind();
  }

  private messageHtml(): string {
    return this.message
      ? `<p class="account-note" role="status">${this.esc(this.message)}</p>`
      : '';
  }
  private bind(): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-act]'))
      button.addEventListener('click', () => void this.act(button.dataset.act ?? ''));
  }

  private async load(): Promise<void> {
    if (!supabase) return;
    const { data, error } = await supabase.rpc('get_profile', {
      p_player_id: this.auth.getState().userId,
    });
    if (error || !data) {
      this.message = 'Could not load your profile. Try again.';
      this.render();
      return;
    }
    this.data = data as ProfileData;
    this.render();
  }

  private async act(action: string): Promise<void> {
    if (action === 'close') {
      this.callbacks.onClose();
      return;
    }
    if (!supabase || !this.data) return;
    if (action === 'save') {
      this.busy = true;
      this.render();
      const country = this.field('country').toUpperCase();
      const { error } = await supabase.rpc('update_profile', {
        p_display_name: this.field('displayName'),
        p_avatar_id: this.root.querySelector<HTMLSelectElement>('[data-field="avatar"]')?.value,
        p_country: country || null,
        p_clear_country: !country,
        p_hidden_from_boards:
          this.root.querySelector<HTMLInputElement>('[data-field="hidden"]')?.checked ?? false,
      });
      this.busy = false;
      this.message = error ? `Could not save profile: ${error.message}` : 'Profile saved.';
      await this.load();
      return;
    }
    if (action === 'report') {
      const { error } = await supabase.rpc('report_player', {
        p_target_player_id: this.field('target'),
        p_reason: this.field('reason'),
      });
      this.message = error
        ? `Report failed: ${error.message}. Try again.`
        : 'Player report submitted.';
      this.render();
      return;
    }
    if (action === 'delete') {
      if (this.field('confirm') !== 'DELETE MY ACCOUNT') {
        this.message = 'Type DELETE MY ACCOUNT to confirm.';
        this.render();
        return;
      }
      this.busy = true;
      this.render();
      const { error } = await supabase.functions.invoke('delete-account', {
        body: { confirmation: 'DELETE MY ACCOUNT' },
      });
      this.busy = false;
      if (error) {
        this.message = 'Account deletion failed. Your account is unchanged. Try again.';
        this.render();
        return;
      }
      await this.auth.signOut();
      this.hide();
      this.message = 'Account deleted.';
    }
  }
}
