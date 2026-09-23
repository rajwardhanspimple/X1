/**
 * OfflineRunQueue: completed runs waiting to be submitted.
 *
 * ## Why IndexedDB
 *
 * A three-minute run is 10,800 input frames, around 300 KB of JSON. localStorage caps at roughly 5 MB for the
 * entire origin, so three or four queued runs would exhaust it and take the quality settings, the model choice
 * and the auth session down with them. IndexedDB has room and stores structured values without a JSON round trip.
 *
 * ## Order is preserved and enforced
 *
 * Records carry an autoincrementing key and flush in that order, stopping at the first failure rather than
 * skipping ahead. Submitting out of order would let a later run's XP land before an earlier one's, and because the
 * server awards level-ups as XP arrives, the unlock sequence the player sees would not match the runs they
 * actually played. AC-ACC-CS-005.2 asks for recorded order for exactly that reason.
 *
 * ## A rejected run stays
 *
 * AC-ACC-CS-005.3 requires the failure to remain visible. Deleting it would leave a player who knows they scored
 * well with no explanation, which is worse than a row marked rejected.
 *
 * ## clientRunId is never regenerated
 *
 * It is the idempotency key the server deduplicates on. Regenerating it on retry would turn one run into two
 * submissions and one of them into a duplicate rejection.
 */

import type { RunLog } from '@rearena/protocol';

const DB_NAME = 'rearena';
const DB_VERSION = 1;
const STORE = 'pending-runs';

/** How a queued record stands. */
export type QueuedStatus =
  /** Waiting to be sent. */
  | 'pending'
  /** Sent, waiting on verification. */
  | 'submitted'
  /** Verified and credited. Safe to delete. */
  | 'verified'
  /** Terminally rejected. Kept so the failure stays visible. */
  | 'rejected';

export interface QueuedRun {
  /** Autoincrement key. Also the recorded order. */
  id?: number;
  /** The server's idempotency key. Never changes, including across retries. */
  clientRunId: string;
  log: RunLog;
  status: QueuedStatus;
  /** When the round ended, for display. Not used for ordering: the key is. */
  recordedAt: number;
  attempts: number;
  lastError: string | null;
}

/** Open the database, creating the store on first use. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // autoIncrement gives monotonic keys, which is what carries recorded order.
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('status', 'status', { unique: false });
        // Unique on clientRunId, so the same run cannot be queued twice by a double-submit.
        store.createIndex('clientRunId', 'clientRunId', { unique: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open IndexedDB'));
  });
}

/** Promisify a request. IndexedDB predates promises and every call needs this. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Result of trying to submit one record. */
export interface SubmitOutcome {
  /** True when the record is done with, whether credited or rejected. */
  terminal: boolean;
  /** True when it was accepted. */
  accepted: boolean;
  error?: string;
}

/** Submits one run. Provided by the caller so the queue does not depend on the submission protocol. */
export type Submitter = (log: RunLog) => Promise<SubmitOutcome>;

export class OfflineRunQueue {
  private db: IDBDatabase | null = null;
  private available = true;
  private flushing = false;

  /**
   * Open the database.
   *
   * A failure here disables the queue rather than throwing. IndexedDB is unavailable in some private browsing
   * modes, and a player in that mode should still be able to play: they lose offline submission, not the game.
   */
  async open(): Promise<boolean> {
    if (this.db) return true;
    try {
      this.db = await openDb();
      return true;
    } catch (error) {
      this.available = false;
      console.info(
        '[rearena] offline run queue unavailable:',
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Queue a completed run.
   *
   * Returns false when the queue is unavailable, so the caller can tell the player their run could not be saved
   * rather than implying it was.
   */
  async enqueue(log: RunLog): Promise<boolean> {
    if (!(await this.open()) || !this.db) return false;

    const record: QueuedRun = {
      clientRunId: log.clientRunId,
      log,
      status: 'pending',
      recordedAt: Date.now(),
      attempts: 0,
      lastError: null,
    };

    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      await promisify(tx.objectStore(STORE).add(record));
      return true;
    } catch (error) {
      /*
       * A constraint error means this clientRunId is already queued, which is a double-submit rather than a
       * failure. Reporting success is correct: the run IS queued.
       */
      if (error instanceof DOMException && error.name === 'ConstraintError') return true;
      console.info('[rearena] could not queue run:', error);
      return false;
    }
  }

  /** Every record, oldest first. */
  async list(): Promise<QueuedRun[]> {
    if (!(await this.open()) || !this.db) return [];
    const tx = this.db.transaction(STORE, 'readonly');
    const all = await promisify(tx.objectStore(STORE).getAll() as IDBRequest<QueuedRun[]>);
    return all.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  /** Counts for the HUD: how many are waiting, and how many failed for good. */
  async counts(): Promise<{ pending: number; rejected: number }> {
    const all = await this.list();
    return {
      pending: all.filter((r) => r.status === 'pending' || r.status === 'submitted').length,
      rejected: all.filter((r) => r.status === 'rejected').length,
    };
  }

  private async put(record: QueuedRun): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(STORE, 'readwrite');
    await promisify(tx.objectStore(STORE).put(record));
  }

  private async remove(id: number): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(STORE, 'readwrite');
    await promisify(tx.objectStore(STORE).delete(id));
  }

  /**
   * Submit everything pending, in recorded order.
   *
   * Stops at the first non-terminal failure rather than continuing. Continuing would break the ordering guarantee
   * and, on an offline device, would produce one failed request per queued run for no benefit.
   *
   * Reentrant calls return immediately: a flush triggered by an online event while one is already running would
   * otherwise submit the same record twice.
   */
  async flush(submit: Submitter): Promise<{ sent: number; failed: number }> {
    if (this.flushing) return { sent: 0, failed: 0 };
    if (!(await this.open()) || !this.db) return { sent: 0, failed: 0 };

    this.flushing = true;
    let sent = 0;
    let failed = 0;

    try {
      const records = await this.list();
      for (const record of records) {
        if (record.status === 'verified' || record.status === 'rejected') continue;

        let outcome: SubmitOutcome;
        try {
          outcome = await submit(record.log);
        } catch (error) {
          record.attempts += 1;
          record.lastError = error instanceof Error ? error.message : String(error);
          await this.put(record);
          failed += 1;
          // Ordered flush: stop here so a later run cannot be credited before this one.
          break;
        }

        if (outcome.accepted) {
          // Credited, so the log is no longer needed and it is the largest thing in the store.
          if (record.id !== undefined) await this.remove(record.id);
          sent += 1;
          continue;
        }

        if (outcome.terminal) {
          // AC-ACC-CS-005.3: excluded from progression, failure retained.
          record.status = 'rejected';
          record.lastError = outcome.error ?? 'Could not be verified.';
          record.attempts += 1;
          await this.put(record);
          failed += 1;
          // Not a blocker: a rejected run has no XP to order against, so the next one can proceed.
          continue;
        }

        record.attempts += 1;
        record.lastError = outcome.error ?? null;
        await this.put(record);
        failed += 1;
        break;
      }
    } finally {
      this.flushing = false;
    }

    return { sent, failed };
  }

  /** Forget a rejected run, once the player has seen why. */
  async discard(id: number): Promise<void> {
    if (!(await this.open())) return;
    await this.remove(id);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
