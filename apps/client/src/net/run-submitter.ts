/**
 * RunSubmitter: send a completed run for verification.
 *
 * ## Order of operations
 *
 * The log is uploaded to Storage BEFORE the run row is inserted. The reverse would leave a row pointing at an object
 * that does not exist, and the verifier would reject it as malformed rather than retry, destroying a legitimate score.
 * A stray object with no row is harmless by comparison: it costs a few kilobytes and can be swept later.
 *
 * ## Why the log is compressed
 *
 * A three-minute run is 10,800 input frames of small integers, most of them repeating. Gzip takes roughly 300 KB down
 * to 20 KB, which is the difference between about 3,000 and 50,000 runs fitting in the 1 GB free storage tier. On a
 * browser without CompressionStream the log uploads uncompressed rather than failing, because a larger upload beats a
 * lost run.
 *
 * ## Duplicates are success
 *
 * A unique violation on (player_id, client_run_id) means this run is already recorded. That is reported as accepted so
 * the offline queue stops retrying: treating it as a failure would retry forever against a constraint that can never
 * yield.
 */

import type { RunLog } from '@rearena/protocol';
import { supabase } from './supabase.js';
import type { AuthSession } from './auth-session.js';
import type { SubmitOutcome } from './offline-run-queue.js';

/** Storage bucket for private run logs. */
const BUCKET = 'runs';

/**
 * XP from a run summary.
 *
 * Computed here only as a PROPOSAL. The verifier recomputes it from the replayed summary and ignores this value, so a
 * modified client claiming a million XP changes nothing. It exists so the results screen can show an estimate while
 * verification is still pending, rather than showing nothing.
 */
export function estimateXp(score: number, kills: number, medals: number): number {
  // Score dominates, kills add a floor for a low-scoring but active round, medals are a small bonus.
  return Math.max(0, Math.floor(score / 10) + kills * 5 + medals * 25);
}

/** Gzip a string where the browser supports it, otherwise return it unchanged. */
async function compress(text: string): Promise<{ body: BlobPart; encoding: 'gzip' | 'identity' }> {
  const bytes = new TextEncoder().encode(text);

  // Feature-detected rather than assumed: CompressionStream is absent on older Safari.
  if (typeof CompressionStream === 'undefined') {
    return { body: bytes, encoding: 'identity' };
  }

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = await new Response(stream).arrayBuffer();
    return { body: compressed, encoding: 'gzip' };
  } catch {
    // Any failure falls back to the raw bytes. A bigger upload is better than no submission.
    return { body: bytes, encoding: 'identity' };
  }
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  // 23505 is unique_violation. The message check covers the REST layer, which does not always pass the code through.
  return code === '23505' || /duplicate key|already exists/i.test(message);
}

function isNetwork(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|load failed|timeout/i.test(message);
}

export interface SubmitterOptions {
  auth: AuthSession;
  /** Set for a daily challenge attempt, so the backend can apply the once-per-day rule. */
  challengeDate?: string | null;
}

/**
 * Build a submitter for the offline queue.
 *
 * Returned as a closure rather than a class because the queue only ever needs one function, and the auth session is
 * the only state involved.
 */
export function createRunSubmitter(options: SubmitterOptions) {
  return async function submit(log: RunLog): Promise<SubmitOutcome> {
    if (!supabase) {
      // No backend. Non-terminal, so the run stays queued for when there is one.
      return { terminal: false, accepted: false, error: 'No connection to the server.' };
    }

    const userId = options.auth.getState().userId;
    if (!userId) {
      return { terminal: false, accepted: false, error: 'Not signed in yet.' };
    }

    const summary = log.summary;
    const encoded = JSON.stringify(log);
    const { body, encoding } = await compress(encoded);
    const bytes = body instanceof ArrayBuffer ? body.byteLength : (body as Uint8Array).byteLength;

    /*
     * Path convention: <player_id>/<client_run_id>.json.gz. The first segment is what the storage RLS policy checks,
     * so a player can only write inside their own prefix.
     */
    const extension = encoding === 'gzip' ? '.json.gz' : '.json';
    const path = `${userId}/${log.clientRunId}${extension}`;

    try {
      // 1. Log first, so a row never points at a missing object.
      const upload = await supabase.storage.from(BUCKET).upload(path, body as BlobPart, {
        contentType: encoding === 'gzip' ? 'application/gzip' : 'application/json',
        // Overwrite on retry: the same clientRunId always produces the same log.
        upsert: true,
      });
      if (upload.error) throw upload.error;

      // 2. The row.
      const insert = await supabase
        .from('runs')
        .insert({
          player_id: userId,
          client_run_id: log.clientRunId,
          map_id: log.matchConfig.mapId,
          mode_id: log.matchConfig.modeId,
          seed: log.matchConfig.seed,
          sim_version: log.matchConfig.simVersion,
          content_hash: log.matchConfig.contentHash,
          client_version: log.clientVersion,
          challenge_date: options.challengeDate ?? null,
          claimed_score: summary.score,
          claimed_summary: summary,
          log_path: path,
          log_bytes: bytes,
        })
        .select('id')
        .single();

      if (insert.error) {
        /*
         * Already submitted. Accepted, so the queue drops it: the run exists on the server and retrying can only fail
         * the same way forever.
         */
        if (isDuplicate(insert.error)) {
          return { terminal: true, accepted: true };
        }
        throw insert.error;
      }

      /*
       * 3. Enqueue verification. A failure here is NOT reported as a failed submission: the run is safely recorded, and
       * the database webhook on runs INSERT is the primary trigger anyway. This call is a belt-and-braces nudge, so
       * failing the whole submission over it would re-upload a log that is already stored.
       */
      const enqueue = await supabase.rpc('enqueue_verification', { p_run_id: insert.data.id });
      if (enqueue.error) {
        console.info('[rearena] run stored; verification will be picked up by the webhook');
      }

      return { terminal: true, accepted: true };
    } catch (error) {
      if (isNetwork(error)) {
        return {
          terminal: false,
          accepted: false,
          error: 'Offline. Your run is saved and will be sent later.',
        };
      }

      /*
       * Anything else is non-terminal too. A terminal verdict here would mark the run rejected and lose a legitimate
       * score over what might be a transient server error; only the VERIFIER may reject a run.
       */
      return {
        terminal: false,
        accepted: false,
        error: error instanceof Error ? error.message : 'Could not submit the run.',
      };
    }
  };
}
