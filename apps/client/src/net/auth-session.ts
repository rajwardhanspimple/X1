/**
 * AuthSession: identity for the game client.
 *
 * ## Gameplay never waits on this
 *
 * A round can start before a session exists and continues if one is never created. The state machine below
 * reports how far it got and the menu reflects it, but nothing in the simulation or the round loop reads auth
 * state. That is what makes AC-ACC-001.3 and AC-ACC-002.5 true by construction rather than by care: guest
 * progress lives in localStorage, written by the score code, and is not conditional on a network call
 * succeeding.
 *
 * ## Upgrade links, it does not re-register
 *
 * Upgrading a guest calls `linkIdentity`, which attaches an email or provider to the EXISTING auth user. The
 * `auth.uid` is unchanged, so the profile row and every verified run keep the same owner and no migration is
 * needed. Calling `signUp` instead would create a second user and orphan the guest's scores. This is ADR-001 of
 * the Accounts and Profiles blueprint, and it is the reason this module never calls signUp for an active guest.
 *
 * ## Failure kinds are distinguished because the right response differs
 *
 * A network failure wants a retry button. A duplicate identity wants a different flow entirely: the identity
 * belongs to another account, so the player must sign in to that one, which abandons the guest progress and
 * therefore needs a confirmation rather than a retry. Collapsing both into "error" would produce a retry loop
 * that can never succeed.
 */

import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase.js';

/** Sign-in methods offered at upgrade. AC-ACC-002.1 requires all four. */
export type SignInMethod = 'password' | 'magic-link' | 'google' | 'discord';

export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  'password',
  'magic-link',
  'google',
  'discord',
];

export function describeMethod(method: SignInMethod): string {
  switch (method) {
    case 'password':
      return 'Email and password';
    case 'magic-link':
      return 'Email link';
    case 'google':
      return 'Google';
    case 'discord':
      return 'Discord';
  }
}

/**
 * Where identity currently stands.
 *
 * `offline` is not an error state. It is the correct state on a fresh clone and whenever the network is down,
 * and the game is fully playable in it.
 */
export type AuthStatus =
  /** Before the first attempt. */
  | 'unknown'
  /** Restoring or creating a session. */
  | 'connecting'
  /** Anonymous session: playable, progress saved to the account, no way back in from another device. */
  | 'guest'
  /** An identity is attached. Progress follows the player to any device. */
  | 'account'
  /** No backend, or it could not be reached. Progress is local only. */
  | 'offline';

/** Why an operation failed, chosen so the UI can offer the right next step. */
export type AuthFailureKind =
  /** Unreachable or timed out. Retry is the answer. */
  | 'network'
  /** The identity is attached to a different account. Signing in is the answer, not retrying. */
  | 'identity-taken'
  /** Wrong email or password. */
  | 'bad-credentials'
  /** Supabase rejected the input, for example a malformed email. */
  | 'invalid-input'
  /** Anonymous sign-ins are not enabled on the project. A setup problem, not a player problem. */
  | 'anonymous-disabled'
  /** Anything else. */
  | 'unknown';

export interface AuthFailure {
  kind: AuthFailureKind;
  /** Player-facing sentence. Never a raw provider message. */
  message: string;
  /** True when trying the same operation again could plausibly work. */
  retryable: boolean;
}

export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  /** Email once an identity is linked. Hidden after sign-out per AC-ACC-002.6. */
  email: string | null;
  /** Providers attached to this user, for the profile screen. */
  providers: string[];
  /** Last failure, or null. Kept in state so a retry button can persist across renders. */
  failure: AuthFailure | null;
  /** True while an operation is in flight, so buttons can disable. */
  busy: boolean;
}

const OFFLINE_STATE: AuthState = {
  status: 'offline',
  userId: null,
  email: null,
  providers: [],
  failure: null,
  busy: false,
};

type Listener = (state: AuthState) => void;

/**
 * Classify a Supabase error.
 *
 * Message matching is unavoidable here: supabase-js surfaces provider and GoTrue errors with inconsistent codes,
 * and the distinctions that matter to the player (already registered, wrong password, offline) are not reliably
 * carried in a machine-readable field. The patterns are kept narrow and everything unmatched falls through to
 * 'unknown', which is treated as retryable, because a wrongly retryable error costs a button press and a wrongly
 * fatal one costs the player their session.
 */
function classify(error: unknown): AuthFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();

  // Fetch failures surface as TypeError with a browser-specific message.
  if (
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout')
  ) {
    return {
      kind: 'network',
      message: 'Could not reach the server. Your progress is safe on this device.',
      retryable: true,
    };
  }

  if (
    text.includes('already registered') ||
    text.includes('already been registered') ||
    text.includes('already exists') ||
    text.includes('identity is already linked') ||
    text.includes('email address is already')
  ) {
    return {
      kind: 'identity-taken',
      // AC-ACC-002.4: direct the player to sign in rather than offering a retry.
      message: 'That account already exists. Sign in to it instead.',
      retryable: false,
    };
  }

  if (text.includes('invalid login credentials') || text.includes('invalid credentials')) {
    return {
      kind: 'bad-credentials',
      message: 'That email and password do not match.',
      retryable: false,
    };
  }

  if (text.includes('anonymous sign-ins are disabled') || text.includes('anonymous_provider')) {
    return {
      kind: 'anonymous-disabled',
      message: 'Guest play is not available right now. Playing offline.',
      retryable: false,
    };
  }

  if (
    text.includes('invalid email') ||
    text.includes('password should be') ||
    text.includes('validation')
  ) {
    return { kind: 'invalid-input', message: raw, retryable: false };
  }

  return { kind: 'unknown', message: 'Something went wrong. Try again.', retryable: true };
}

/** Provider names attached to a user, for the profile screen. */
function providersOf(user: User | null): string[] {
  if (!user) return [];
  const identities = user.identities ?? [];
  return identities.map((i) => i.provider).filter((p) => p !== 'anonymous');
}

/**
 * Is this an anonymous user?
 *
 * `is_anonymous` is the authoritative field, but it was added later than the rest of this API, so the identity
 * list is checked as a fallback: a user with no non-anonymous identity is still a guest whatever the flag says.
 */
function isGuest(user: User | null): boolean {
  if (!user) return false;
  if (user.is_anonymous === true) return true;
  return providersOf(user).length === 0 && !user.email;
}

export class AuthSession {
  private state: AuthState = { ...OFFLINE_STATE, status: 'unknown' };
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private fromSession(session: Session | null, failure: AuthFailure | null = null): void {
    const user = session?.user ?? null;
    if (!user) {
      this.set({ status: 'offline', userId: null, email: null, providers: [], failure, busy: false });
      return;
    }
    this.set({
      status: isGuest(user) ? 'guest' : 'account',
      userId: user.id,
      // AC-ACC-002.6: a guest has no email to show, and sign-out clears this.
      email: user.email ?? null,
      providers: providersOf(user),
      failure,
      busy: false,
    });
  }

  /**
   * Restore a session, or create a guest one.
   *
   * Called once at boot and safe to call again after a failure, which is what the retry button does.
   */
  async start(): Promise<AuthState> {
    if (!supabase) {
      // No backend. Offline is correct, not an error, so no failure is recorded.
      this.set({ ...OFFLINE_STATE });
      return this.state;
    }

    this.set({ status: 'connecting', busy: true, failure: null });

    // React to token refresh, sign-out in another tab, and the OAuth redirect completing.
    if (!this.unsubscribe) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        this.fromSession(session);
      });
      this.unsubscribe = () => data.subscription.unsubscribe();
    }

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      if (data.session) {
        // AC-ACC-002.3: an existing session restores the account on any device.
        this.fromSession(data.session);
        return this.state;
      }

      return await this.createGuest();
    } catch (error) {
      /*
       * AC-ACC-001.4 and AC-ACC-002.5: explain and offer retry, without discarding anything. Status becomes
       * offline rather than a distinct error state, because the game is genuinely playable here and the
       * difference the player cares about is whether progress leaves the device.
       */
      this.set({ status: 'offline', busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /** AC-ACC-001.1 and 001.2: a guest identity with a generated display name, no form. */
  private async createGuest(): Promise<AuthState> {
    if (!supabase) return this.state;
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      /*
       * The display name comes from the on_auth_user_created trigger, not from here. Generating it client-side
       * would risk a collision with the unique constraint and would duplicate a rule that has to live in
       * Postgres anyway for cross-device consistency.
       */
      this.fromSession(data.session);
      return this.state;
    } catch (error) {
      this.set({ status: 'offline', busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /** Retry after a failure. Same path as boot. */
  async retry(): Promise<AuthState> {
    return this.start();
  }

  /**
   * Attach an email and password to the current user.
   *
   * updateUser rather than signUp: it links the identity to the existing auth.uid, so the profile and every
   * verified run keep their owner. See ADR-001.
   */
  async upgradeWithPassword(email: string, password: string): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ busy: true, failure: null });
    try {
      const { data, error } = await supabase.auth.updateUser({ email, password });
      if (error) throw error;
      // AC-ACC-002.2: same user, so progress is retained with no migration.
      this.set({
        status: data.user && isGuest(data.user) ? 'guest' : 'account',
        email: data.user?.email ?? null,
        providers: providersOf(data.user ?? null),
        busy: false,
        failure: null,
      });
      return this.state;
    } catch (error) {
      // AC-ACC-002.5: the guest identity is untouched by a failed upgrade.
      this.set({ busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /** Send a one-time sign-in link. */
  async upgradeWithMagicLink(email: string): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ busy: true, failure: null });
    try {
      const { error } = await supabase.auth.updateUser({ email });
      if (error) throw error;
      this.set({ busy: false, failure: null });
      return this.state;
    } catch (error) {
      this.set({ busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /**
   * Link an OAuth provider to the current user.
   *
   * linkIdentity, not signInWithOAuth. The latter would sign in as a different user and abandon the guest's
   * progress, which is exactly the outcome ADR-001 rules out.
   *
   * This redirects, so the returned state is only meaningful on failure; success resumes in start() after the
   * redirect, where detectSessionInUrl completes the flow.
   */
  async upgradeWithProvider(provider: 'google' | 'discord'): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ busy: true, failure: null });
    try {
      const { error } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
      return this.state;
    } catch (error) {
      this.set({ busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /**
   * Sign in to an existing account.
   *
   * This REPLACES the current session, so any guest progress not already on that account is left behind. The
   * caller must confirm with the player first; this method does not, because a confirmation dialog is a UI
   * concern and burying one here would make the method unusable from a screen that already asked.
   */
  async signInWithPassword(email: string, password: string): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ busy: true, failure: null });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.fromSession(data.session);
      return this.state;
    } catch (error) {
      this.set({ busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /** Sign in with a provider, replacing the current session. Same caveat as signInWithPassword. */
  async signInWithProvider(provider: 'google' | 'discord'): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ busy: true, failure: null });
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
      return this.state;
    } catch (error) {
      this.set({ busy: false, failure: classify(error) });
      return this.state;
    }
  }

  /**
   * Sign out and clear private fields.
   *
   * AC-ACC-002.6. A new guest session is NOT created automatically: a player who just signed out and is
   * immediately handed a fresh anonymous identity has not really signed out from their point of view. The menu
   * offers guest play as an explicit choice instead.
   */
  async signOut(): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ busy: true, failure: null });
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      this.set({ ...OFFLINE_STATE });
      return this.state;
    } catch (error) {
      // Clear locally regardless: a failed sign-out that leaves the account visible is the worse outcome.
      this.set({ ...OFFLINE_STATE, failure: classify(error) });
      return this.state;
    }
  }

  /** Start a guest session explicitly, after a sign-out or a failed attempt. */
  async playAsGuest(): Promise<AuthState> {
    if (!supabase) return this.state;
    this.set({ status: 'connecting', busy: true, failure: null });
    return this.createGuest();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}

/** One-line description of the current state, for the menu. */
export function describeAuthState(state: AuthState): string {
  switch (state.status) {
    case 'unknown':
    case 'connecting':
      return 'Connecting...';
    case 'guest':
      return 'Playing as guest. Sign in to keep your progress.';
    case 'account':
      return state.email ? `Signed in as ${state.email}` : 'Signed in';
    case 'offline':
      return state.failure
        ? state.failure.message
        : 'Playing offline. Progress is saved on this device.';
  }
}
