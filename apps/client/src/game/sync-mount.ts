/**
 * Sync mount: settings, loadouts and the offline run queue.
 *
 * ## Sync intent, not measurement
 *
 * This is the rule that shapes the settings bridge below, and it was learned the hard way. The first version synced
 * the whole quality object, including a tier that came from the hardware probe rather than from the player. That
 * meant a desktop's probed "ultra" was handed to a phone, and because quality.ts treats the presence of its storage
 * key as proof the probe has already run, the phone accepted ultra and never measured its own hardware. The result
 * is an unplayable frame rate with nothing to explain it.
 *
 * So a probed tier stays local and only a manual choice travels. Frame cap, dynamic resolution and the stats
 * overlay travel either way: those express what the player wants to see, not what this GPU can manage.
 *
 * ## Why a bridge over localStorage rather than module references
 *
 * The obvious design is to hand SettingsSyncService a reference to the quality store and the audio engine. That
 * would create two objects with authority over the same values: quality.ts already persists its own settings and
 * applies them itself, so a sync service that also writes them would race with it.
 *
 * The bridge instead treats the existing localStorage keys as the single source of truth. It reads them to push and
 * writes them to pull, so the owning modules keep full ownership and this file needs no knowledge of what a tier or
 * an audio level means.
 *
 * ## Why a pulled change reloads the page
 *
 * Applying a quality tier disposes and rebuilds the arena, the enemy renderer and the effect pools. Doing that from
 * a storage write mid-frame would tear down objects the render loop is using. A reload is honest about the cost,
 * happens once per pull, and is instant on a dev server.
 *
 * A model change does not reload. It is a rendering choice that applies on the next round, and reloading the page
 * to apply it would hide the loader's error in the reload itself.
 */

import type { RunLog } from '@rearena/protocol';
import type { AuthSession } from '../net/auth-session.js';
import { LoadoutStore } from '../net/loadout-store.js';
import { OfflineRunQueue, type SubmitOutcome } from '../net/offline-run-queue.js';
import { createRunSubmitter } from '../net/run-submitter.js';
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

/**
 * Quality fields that are safe to carry between devices.
 *
 * `tier` is absent on purpose, and is added back only when the player chose it. See the note at the top of the
 * file: a probed tier describes this hardware, and hardware is the one thing that does not travel with an account.
 */

const PORTABLE_QUALITY_FIELDS = ['frameRateCap', 'dynamicResolution', 'showFrameStats'] as const;

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

/** The portable subset of a stored quality object. */
function portableQuality(stored: unknown): Record<string, unknown> | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const source = stored as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const field of PORTABLE_QUALITY_FIELDS) {
    if (source[field] !== undefined) out[field] = source[field];
  }

  /*
   * A manually chosen tier is intent and travels. A probed one is a measurement of this device and stays. Carrying
   * `manual` alongside it matters: without the flag the receiving device cannot tell the difference either.
   */
  if (source.manual === true && typeof source.tier === 'string') {
    out.tier = source.tier;
    out.manual = true;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Whether a finished run reached the server. */
export type SubmissionResult =
  /** Stored and queued for verification. */
  | { state: 'submitted' }
  /** Kept on this device and retried later; `error` is the player-facing reason. */
  | { state: 'failed'; error: string }
  /** Could not even be saved locally, typically private browsing without IndexedDB. */
  | { state: 'unsaved' };

export interface SyncMount {
  settings: SettingsSyncService;
  loadouts: LoadoutStore;
  runQueue: OfflineRunQueue;
  /** Call after any settings change so the cloud copy catches up. */
  notifySettingsChanged(): void;
  /** Queue a finished run for submission. */
  queueRun(log: RunLog): Promise<boolean>;
  /**
   * Queue a run, try to send it now, and report whether it reached the server. Safe to call again with the same log
   * to retry: the queue keys on clientRunId, so a second call resends rather than duplicating.
   */
  submitRun(log: RunLog): Promise<SubmissionResult>;
  dispose(): void;
}


/**
 * Mount the sync services.
 *
 * `submit` defaults to the real RunSubmitter, which uploads the log to Storage and inserts the run row. It used to
 * default to a placeholder written before submission existed, and main never passed one, so every run was queued and
 * then refused. Callers may still pass their own, for tests.
 */
export function mountSync(
  auth: AuthSession,
  submit: (log: RunLog) => Promise<SubmitOutcome> = createRunSubmitter({ auth }),
): SyncMount {
  let reloading = false;

  const bridge: SettingsBridge = {
    collect(): SyncedSettings {
      const settings: SyncedSettings = {};

      const quality = portableQuality(readJson(KEYS.quality));
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

      /*
       * Quality merges field by field into whatever is stored locally, rather than replacing it. A replace would
       * drop this device's probed tier, and since quality.ts reads the key's existence as "probe already done", the
       * device would end up with no tier and no probe.
       */
      const incoming = settings.quality;
      if (typeof incoming === 'object' && incoming !== null) {
        const local = (readJson(KEYS.quality) as Record<string, unknown> | undefined) ?? {};
        const merged = { ...local, ...(incoming as Record<string, unknown>) };
        const next = JSON.stringify(merged);
        if (next !== readRaw(KEYS.quality)) {
          write(KEYS.quality, merged);
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
        // A model change does not reload: the loader applies it on the next round, and reloading would hide
        // the loader's error in the reload itself.
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
    async submitRun(log: RunLog): Promise<SubmissionResult> {
      const queued = await runQueue.enqueue(log);
      if (!queued) return { state: 'unsaved' };
      await runQueue.flush(submit);
      // An accepted run is removed from the queue, so still finding it here means it did not go out.
      const left = (await runQueue.list()).find((r) => r.clientRunId === log.clientRunId);
      if (!left) return { state: 'submitted' };
      return { state: 'failed', error: left.lastError ?? 'Could not submit the run.' };
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
      // What would be pushed right now, so the portable subset is inspectable.
      payload: settings.getState().status === 'idle' ? null : undefined,
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
