/**
 * Sync mount: settings, loadouts and the offline run queue.
 *
 * ## Why a bridge over localStorage rather than module references
 *
 * The obvious design is to hand SettingsSyncService a reference to the quality store and the audio engine. That
 * would create two objects with authority over the same values: quality.ts already persists its own settings and
 * applies them itself, so a sync service that also writes them would race with it.
 *
 * So the bridge treats the existing localStorage keys as the single source of truth. It reads them to push and
 * writes them to pull, which means the owning modules keep full ownership and this file needs no knowledge of what
 * a quality tier or an audio level means.
 *
 * ## Why a pulled change reloads the page
 *
 * Applying a quality tier disposes and rebuilds the arena, the enemy renderer and the effect pools. Doing that
 * from a storage write mid-frame would tear down objects the render loop is using. A reload is honest about the
 * cost, happens once per pull, and is instant on a dev server. It is guarded by a flag so a pull that changes
 * nothing does not reload, and so two pulls cannot reload twice.
 */

import type { RunLog } from '@rearena/protocol';
import type { AuthSession } from '../net/auth-session.js';
import { LoadoutStore } from '../net/loadout-store.js';
import { OfflineRunQueue, type SubmitOutcome } from '../net/offline-run-queue.js';
import {
  SettingsSyncService,
  describeSyncState,
  type SettingsBridge,
  type SyncedSettings,
  type SyncState,
} from '../net/settings-sync.js';
import { isBackendConfigured } from '../net/supabase.js';

/*
 * The localStorage keys the client already uses. Duplicated from their owning modules rather than exported, because
 * exporting them would invite other code to write them directly, which is the coupling this bridge exists to avoid.
 * A key rename breaks sync loudly (settings stop syncing) rather than silently corrupting anything.
 */
const KEYS = {
  quality: 'rearena.quality.v1',
  selection: 'rearena.selection.v1',
  model: 'rearena.model.v1',
} as const;

/** Read a JSON value from localStorage, or undefined when absent or corrupt. */
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readRaw(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // Private browsing. The setting still applies for this session.
  }
}

export interface SyncMount {
  settings: SettingsSyncService;
  loadouts: LoadoutStore;
  runQueue: OfflineRunQueue;
  /** Call after any settings change so the cloud copy catches up. */
  notifySettingsChanged(): void;
  /** Queue a finished run for submission. */
  queueRun(log: RunLog): Promise<boolean>;
  dispose(): void;
}

/**
 * Mount the sync services.
 *
 * `submit` is supplied by the caller because the submission endpoint arrives with WO-53. Until then the default
 * reports a non-terminal failure, so runs accumulate in the queue and flush once submission exists rather than
 * being discarded.
 */
export function mountSync(
  auth: AuthSession,
  submit: (log: RunLog) => Promise<SubmitOutcome> = notYetImplemented,
): SyncMount {
  let reloading = false;

  const bridge: SettingsBridge = {
    collect(): SyncedSettings {
      const settings: SyncedSettings = {};
      const quality = readJson(KEYS.quality);
      if (quality !== undefined) settings.quality = quality;
      const selection = readJson(KEYS.selection);
      if (selection !== undefined) settings.selection = selection;
      // The model id is a bare string, not JSON, so it is read and written as one.
      const model = readRaw(KEYS.model);
      if (model !== undefined) settings.model = model;
      return settings;
    },

    apply(settings: SyncedSettings): void {
      let changed = false;

      if (settings.quality !== undefined) {
        const next = JSON.stringify(settings.quality);
        if (next !== readRaw(KEYS.quality)) {
          write(KEYS.quality, settings.quality);
          changed = true;
        }
      }

      if (settings.selection !== undefined) {
        const next = JSON.stringify(settings.selection);
        if (next !== readRaw(KEYS.selection)) {
          write(KEYS.selection, settings.selection);
          changed = true;
        }
      }

      if (typeof settings.model === 'string' && settings.model !== readRaw(KEYS.model)) {
        write(KEYS.model, settings.model);
        changed = true;
      }

      /*
       * Reload rather than applying live. A quality change rebuilds the arena, the enemy renderer and the effect
       * pools, and doing that from here would dispose objects the render loop is mid-way through using. The guard
       * makes it once-only.
       */
      if (changed && !reloading) {
        reloading = true;
        console.info('[rearena] applied settings from your account, reloading');
        setTimeout(() => window.location.reload(), 150);
      }
    },
  };

  const settings = new SettingsSyncService(auth, bridge);
  const loadouts = new LoadoutStore(auth);
  const runQueue = new OfflineRunQueue();

  settings.start();

  // Loadouts load once a session exists, and reload on sign-in so a second device sees its own unlocks.
  let lastUserId: string | null = null;
  const unsubscribeAuth = auth.subscribe((state) => {
    if (state.userId === lastUserId) return;
    lastUserId = state.userId;
    void loadouts.load();
    // A session appearing is also the moment queued runs can go out.
    if (state.userId) void runQueue.flush(submit);
  });

  /*
   * Flush when the browser regains connectivity. The online event is unreliable on its own (it fires for a captive
   * portal too), but a failed flush costs one request and leaves the queue intact, so an optimistic attempt is the
   * right trade.
   */
  const onOnline = (): void => {
    void settings.retry();
    void runQueue.flush(submit);
  };
  window.addEventListener('online', onOnline);

  /*
   * pagehide rather than beforeunload: it fires on mobile when the tab is backgrounded, which is where a pending
   * debounced write is most likely to be lost. beforeunload is not guaranteed on iOS at all.
   */
  const onPageHide = (): void => {
    settings.flushNow();
  };
  window.addEventListener('pagehide', onPageHide);

  attachDevHelper(settings, loadouts, runQueue);

  return {
    settings,
    loadouts,
    runQueue,
    notifySettingsChanged() {
      settings.notifyChanged();
    },
    async queueRun(log: RunLog) {
      const queued = await runQueue.enqueue(log);
      if (queued) void runQueue.flush(submit);
      return queued;
    },
    dispose() {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
      unsubscribeAuth();
      settings.dispose();
      loadouts.dispose();
      runQueue.close();
    },
  };
}

/**
 * Placeholder submitter until WO-53 builds the endpoint.
 *
 * Reports a NON-terminal failure on purpose: a terminal one would mark every queued run rejected and lose it. This
 * way runs accumulate and flush for real once submission exists.
 */
async function notYetImplemented(): Promise<SubmitOutcome> {
  return {
    terminal: false,
    accepted: false,
    error: 'Run submission is not available yet. Your run is saved and will be sent later.',
  };
}

/** Console helpers, development builds only. Merged onto whatever rearena object exists. */
function attachDevHelper(
  settings: SettingsSyncService,
  loadouts: LoadoutStore,
  runQueue: OfflineRunQueue,
): void {
  if (!import.meta.env.DEV) return;

  const target = window as unknown as { rearena?: Record<string, unknown> };
  target.rearena ??= {};

  target.rearena.sync = () => {
    const state: SyncState = settings.getState();
    return {
      backend: isBackendConfigured() ? 'configured' : 'offline',
      status: state.status,
      summary: describeSyncState(state),
      lastSyncedAt: state.lastSyncedAt,
      error: state.error,
    };
  };

  target.rearena.loadouts = () => {
    const state = loadouts.getState();
    return {
      slots: state.loadouts,
      available: [...state.available],
      stale: state.stale,
      error: state.error,
    };
  };

  target.rearena.queue = async () => {
    const all = await runQueue.list();
    return all.map((r) => ({
      id: r.id,
      clientRunId: r.clientRunId,
      status: r.status,
      attempts: r.attempts,
      score: r.log.summary.score,
      recordedAt: new Date(r.recordedAt).toISOString(),
      lastError: r.lastError,
    }));
  };

  target.rearena.syncNow = () => {
    settings.flushNow();
    return 'Pushing settings now.';
  };
}
