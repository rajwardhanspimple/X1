/**
 * SettingsSyncService: player settings across devices.
 *
 * ## Local first, always
 *
 * A setting applies the moment it changes and is written to localStorage before any network call. The cloud is a
 * mirror that catches up afterwards. Nothing in the UI waits for a round trip, and nothing is lost when one
 * fails, which is what makes AC-ACC-CS-004.3 and AC-ACC-CS-004.5 true by construction rather than by careful
 * error handling.
 *
 * The inverse design (write to the server, then apply locally on success) would make every settings change feel
 * slow on a good connection and impossible on a bad one.
 *
 * ## Conflicts resolve on the server's clock
 *
 * Two devices changing the same setting is resolved by `updated_at`, which Postgres sets. Comparing client
 * timestamps would be wrong in a way that is hard to notice: a device with a skewed clock would win or lose every
 * conflict regardless of when the player actually made the change, and the player would experience it as settings
 * randomly reverting.
 *
 * ## Writes are debounced
 *
 * Dragging a volume slider fires dozens of change events. One request per event would spend a meaningful share of
 * the free tier's budget on a single gesture, so changes coalesce into one write.
 *
 * ## Guests sync too
 *
 * A guest has a real user id and a real settings row, so their settings are already in the cloud when they
 * upgrade. That leaves the merge in AC-ACC-CS-005.4 with nothing to do for this domain, which is the cheapest way
 * to satisfy it.
 */

import { supabase } from './supabase.js';
import type { AuthSession, AuthState } from './auth-session.js';

/** Delay before a change is pushed. Long enough to coalesce a drag, short enough to feel immediate. */
const DEBOUNCE_MS = 1200;

/** Local mirror of the last known cloud state, so a reload does not re-push unchanged settings. */
const MIRROR_KEY = 'rearena.settings.mirror.v1';

/**
 * Settings synced to the cloud.
 *
 * A flat record rather than a typed shape on purpose: this service moves values without understanding them, and
 * the owning modules (quality, audio, input) keep their own types. Adding a setting therefore needs no change
 * here, and an older client reading a newer row ignores keys it does not know rather than failing.
 */
export type SyncedSettings = Record<string, unknown>;

export type SyncStatus =
  /** Nothing to do: no backend or no session. */
  | 'idle'
  /** In sync with the cloud. */
  | 'synced'
  /** A change is waiting to be pushed. */
  | 'pending'
  /** Pushing or pulling right now. */
  | 'syncing'
  /** The last attempt failed. Local settings are intact and the change is still queued. */
  | 'failed';

export interface SyncState {
  status: SyncStatus;
  /** When the cloud row was last written, from the server. */
  lastSyncedAt: string | null;
  /** Why the last attempt failed, for the settings screen. */
  error: string | null;
}

type Listener = (state: SyncState) => void;

/** What the service reads from and writes to the rest of the client. */
export interface SettingsBridge {
  /** Everything that should be synced, gathered from the owning modules. */
  collect(): SyncedSettings;
  /**
   * Apply settings pulled from the cloud.
   *
   * Called with the merged result, never with a partial patch, so a module can apply the whole set without
   * tracking which keys arrived.
   */
  apply(settings: SyncedSettings): void;
}

interface Mirror {
  settings: SyncedSettings;
  updatedAt: string | null;
  version: number;
}

function readMirror(): Mirror {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Mirror>;
      return {
        settings: (parsed.settings as SyncedSettings) ?? {},
        updatedAt: parsed.updatedAt ?? null,
        version: typeof parsed.version === 'number' ? parsed.version : 0,
      };
    }
  } catch {
    // Corrupt or unavailable storage. An empty mirror re-pulls, which is the safe direction.
  }
  return { settings: {}, updatedAt: null, version: 0 };
}

function writeMirror(mirror: Mirror): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    // Private browsing. Sync still works, it just re-pulls on the next load.
  }
}

/** Shallow equality over the synced keys. Enough: values are primitives and short arrays. */
function sameSettings(a: SyncedSettings, b: SyncedSettings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

export class SettingsSyncService {
  private state: SyncState = { status: 'idle', lastSyncedAt: null, error: null };
  private readonly listeners = new Set<Listener>();
  private mirror = readMirror();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private userId: string | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private inFlight = false;
  /** Set when a change arrives while a push is in flight, so it is not silently dropped. */
  private dirtyDuringFlight = false;

  constructor(
    private readonly auth: AuthSession,
    private readonly bridge: SettingsBridge,
  ) {}

  getState(): SyncState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Begin syncing, and pull whenever a session appears.
   *
   * Subscribing to auth rather than being called once matters for AC-ACC-CS-004.1: a player who signs in on a
   * second device gets the pull from the auth transition, with no extra wiring at the call site.
   */
  start(): void {
    if (!supabase) {
      this.set({ status: 'idle' });
      return;
    }

    this.unsubscribeAuth = this.auth.subscribe((authState: AuthState) => {
      const next = authState.userId;
      if (next === this.userId) return;
      this.userId = next;

      if (next === null) {
        // Signed out. Local settings stay exactly as they are; only cloud sync stops.
        this.set({ status: 'idle', error: null });
        return;
      }

      void this.pull();
    });
  }

  /**
   * Pull cloud settings and apply them.
   *
   * The cloud wins here, which is correct for this direction: a pull happens on sign-in or session restore, when
   * the cloud row is by definition the more recent record of what the player chose on some device.
   */
  async pull(): Promise<void> {
    if (!supabase || !this.userId) return;
    this.set({ status: 'syncing', error: null });

    try {
      const { data, error } = await supabase
        .from('player_settings')
        .select('settings, version, updated_at')
        .eq('player_id', this.userId)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        /*
         * No row yet, which happens if the provisioning trigger has not run. Push what is local rather than
         * treating it as an error: the player's current settings are the best available truth.
         */
        await this.push();
        return;
      }

      const remote = (data.settings ?? {}) as SyncedSettings;
      const local = this.bridge.collect();

      /*
       * Only apply when the remote row differs from what this device last saw. Without that check, a device that
       * just pushed would immediately re-apply its own write, and any local change made during the round trip
       * would be reverted.
       */
      if (!sameSettings(remote, this.mirror.settings)) {
        this.bridge.apply({ ...local, ...remote });
      }

      this.mirror = {
        settings: remote,
        updatedAt: (data.updated_at as string | null) ?? null,
        version: (data.version as number | null) ?? 0,
      };
      writeMirror(this.mirror);

      // A local change made before the pull completed still needs pushing.
      const current = this.bridge.collect();
      if (!sameSettings(current, remote)) {
        this.set({ status: 'pending', lastSyncedAt: this.mirror.updatedAt, error: null });
        this.schedulePush();
        return;
      }

      this.set({ status: 'synced', lastSyncedAt: this.mirror.updatedAt, error: null });
    } catch (error) {
      // AC-ACC-CS-004.5: local settings are retained, and the state says a change is still pending.
      this.set({ status: 'failed', error: this.describe(error) });
    }
  }

  /**
   * Note that settings changed. Cheap and safe to call on every change event.
   *
   * This does NOT write locally: the owning module already did that. It only schedules the cloud push.
   */
  notifyChanged(): void {
    if (!supabase || !this.userId) return;
    if (this.inFlight) {
      this.dirtyDuringFlight = true;
      return;
    }
    this.set({ status: 'pending' });
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push();
    }, DEBOUNCE_MS);
  }

  /** Push local settings. Safe to call directly; notifyChanged is the debounced entry point. */
  async push(): Promise<void> {
    if (!supabase || !this.userId) return;

    const settings = this.bridge.collect();
    if (sameSettings(settings, this.mirror.settings)) {
      this.set({ status: 'synced', error: null });
      return;
    }

    this.inFlight = true;
    this.dirtyDuringFlight = false;
    this.set({ status: 'syncing', error: null });

    try {
      /*
       * upsert rather than update, because the row may not exist if the provisioning trigger has not run. version
       * increments monotonically so a reader can tell which write is newer without trusting a clock, and
       * updated_at is set by the database trigger rather than here.
       */
      const { data, error } = await supabase
        .from('player_settings')
        .upsert(
          {
            player_id: this.userId,
            settings,
            version: this.mirror.version + 1,
          },
          { onConflict: 'player_id' },
        )
        .select('version, updated_at')
        .single();

      if (error) throw error;

      this.mirror = {
        settings,
        updatedAt: (data.updated_at as string | null) ?? null,
        version: (data.version as number | null) ?? this.mirror.version + 1,
      };
      writeMirror(this.mirror);
      this.inFlight = false;

      // A change that arrived mid-flight would otherwise be lost, since the mirror now matches the old values.
      if (this.dirtyDuringFlight) {
        this.dirtyDuringFlight = false;
        this.set({ status: 'pending', lastSyncedAt: this.mirror.updatedAt });
        this.schedulePush();
        return;
      }

      this.set({ status: 'synced', lastSyncedAt: this.mirror.updatedAt, error: null });
    } catch (error) {
      this.inFlight = false;
      // AC-ACC-CS-004.5 again: the change stays queued and local settings are untouched.
      this.set({ status: 'failed', error: this.describe(error) });
    }
  }

  /** Retry after a failure. */
  async retry(): Promise<void> {
    await this.push();
  }

  /**
   * Flush immediately, without waiting for the debounce.
   *
   * Called from a pagehide handler: a pending change would otherwise be lost when the tab closes, and this is the
   * one case where the debounce is actively harmful.
   */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.push();
  }

  private describe(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror|load failed|timeout/i.test(raw)) {
      return 'Offline. Your settings are saved on this device and will sync later.';
    }
    return 'Could not save settings to the cloud. They are saved on this device.';
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.unsubscribeAuth?.();
    this.listeners.clear();
  }
}

/** One-line description for the settings screen. */
export function describeSyncState(state: SyncState): string {
  switch (state.status) {
    case 'idle':
      return 'Saved on this device';
    case 'synced':
      return 'Synced to your account';
    case 'pending':
      return 'Saving...';
    case 'syncing':
      return 'Syncing...';
    case 'failed':
      return state.error ?? 'Saved on this device only';
  }
}
