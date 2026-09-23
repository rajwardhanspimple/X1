// verify-run: the RE:Arena Verifier as a Supabase Edge Function (Deno).
//
// ## Why this is chunked
//
// The free plan gives an Edge Function 2 seconds of CPU. A three-minute run is 10,800 ticks of deterministic
// simulation, which is well past that. So one run is verified across a chain of invocations: each claims the job,
// replays a slice, serialises the simulation state, and posts back to itself for the next slice.
//
// That is the reason SimState serialisation exists at all, and the reason replaySlice is a separate entry point from
// replay: the property that a log replayed in slices of any size produces byte-identical state to one replayed in a
// single pass is what makes this safe, and packages/sim has tests for exactly that.
//
// ## What is trusted
//
// Nothing from the client except the input frames. The score, kills, accuracy and medals are all recomputed from the
// replay, and the claimed summary is only ever compared against them. A claim that exceeds the replay is a rejection,
// because that is precisely the signature of a tampered client.
//
// ## Each invocation
//
//   1. check x-verifier-secret
//   2. claim the job with a conditional UPDATE, so two invocations cannot replay the same slice
//   3. restore state (or start at tick 0) and replay up to SLICE_TICKS, comparing checkpoint hashes as they pass
//   4a. ticks remain: persist state and cursor, then post back for the next slice
//   4b. done: compare the replayed summary against the claim and commit or reject
//
// A pg_cron reconciler (reconcile_verification_jobs) kicks this function when a job has sat idle, so a failed chain call
// delays a verdict rather than losing it.
//
// See blueprint: RE:Arena Verifier.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createGreyboxWorld,
  greyboxEnemySpawns,
  greyboxPlayerSpawns,
  replaySlice,
  FixedMath,
  SIM_VERSION,
  type SimContent,
} from '@rearena/sim';
import type { RunLog } from '@rearena/protocol';

/**
 * Ticks per slice.
 *
 * 6000 ticks is 100 seconds of simulation. Measured at roughly 0.6 s of CPU, which leaves generous headroom under the
 * 2 s cap for the fetch, the decompression and the commit. Tunable by env var so a slow region can be dialled down
 * without a redeploy.
 */
const SLICE_TICKS = Number(Deno.env.get('VERIFIER_SLICE_TICKS') ?? '6000');

/** Lease length for a claimed job. Longer than a slice takes, short enough that a crashed invocation frees it soon. */
const LEASE_SECONDS = 30;

/** Ghost promotion threshold: a run in the top few of its board is worth racing against. */
const GHOST_RANK_LIMIT = 10;

/**
 * The name this function is deployed under, which is where the next slice is posted.
 *
 * `pnpm functions:deploy` deploys the esbuild bundle as `verify-run-bundled`, because the unbundled source cannot resolve its
 * workspace imports under Deno. Posting to `verify-run` would reach nothing, and every run longer than one slice would stall
 * after its first. An env var rather than a constant, so a rename is a secret change rather than a redeploy.
 */
const FUNCTION_NAME = Deno.env.get('VERIFIER_FUNCTION_NAME') ?? 'verify-run-bundled';

/**
 * XP from a verified summary.
 *
 * The authoritative formula. The client has its own estimate for display, and this deliberately ignores it: an
 * estimate the server trusted would be a way to grant arbitrary XP.
 */
function xpForRun(summary: RunLog['summary']): number {
  return Math.max(
    0,
    Math.floor(summary.score / 10) + summary.kills * 5 + summary.medals.length * 25,
  );
}

/**
 * Rebuild the SimContent for a run.
 *
 * Rebuilt from the layout module bundled with this function rather than fetched, so the geometry the verifier replays
 * against is the geometry the SIM_VERSION it carries was built from. The SIM_VERSION gate in the handler runs before any
 * of this and rejects a run recorded under an older version, which is the check that keeps a stale deploy from verifying
 * runs against the wrong arena.
 *
 * The claimed contentHash is passed through rather than compared. Comparing it against the layout in this same bundle
 * would always agree, so it is not the integrity check it looks like. WO-10 and WO-52 replace this with a real content
 * fetch once published manifests exist.
 */
function contentForRun(log: RunLog): SimContent {
  const world = createGreyboxWorld();
  return {
    hash: log.matchConfig.contentHash,
    durationTicks: 10800,
    boxes: world.boxes,
    bounds: world.bounds,
    spawns: greyboxPlayerSpawns(),
    spawnYaw: 0,
    enemySpawns: greyboxEnemySpawns(),
    maxHealth: FixedMath.fromInt(100),
    weapons: [log.matchConfig.loadout.primaryWeapon, log.matchConfig.loadout.secondaryWeapon],
  };
}

/** Download and parse a run log from Storage. */
async function fetchLog(supabase: SupabaseClient, path: string): Promise<RunLog> {
  const { data, error } = await supabase.storage.from('runs').download(path);
  if (error) throw new Error(`could not download log: ${error.message}`);

  /*
   * The path extension records whether the client compressed it. Sniffing the gzip magic number would also work, but
   * the extension is written by the same code that chose the encoding, so it cannot disagree.
   */
  if (path.endsWith('.gz')) {
    const stream = data.stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return JSON.parse(text) as RunLog;
  }

  return JSON.parse(await data.text()) as RunLog;
}

/** Base64 for the state blob, since JSON cannot carry bytes and bytea arrives as a string. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: a spread over a 100 KB array overflows the argument limit in some runtimes.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Post back to this function for the next slice. */
async function chain(jobId: string, secret: string): Promise<void> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/${FUNCTION_NAME}`;
  /*
   * Deliberately not awaited for its result beyond dispatch: this invocation has done its slice, and waiting for the
   * whole remaining chain would reintroduce the CPU limit this design exists to avoid.
   */
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-verifier-secret': secret,
      authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    body: JSON.stringify({ job_id: jobId }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const secret = Deno.env.get('VERIFIER_WEBHOOK_SECRET');
  if (!secret || req.headers.get('x-verifier-secret') !== secret) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY into every Edge Function.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  const body = await req.json().catch(() => null);

  /*
   * Three payload shapes. A Database Webhook on runs INSERT sends { record }, a chained call sends { job_id }, and the
   * reconciler sends {}. All three go on to claim, so the first slice needs no separate trigger path.
   */
  const explicitJob: string | undefined = body?.job_id;
  const insertedRunId: string | undefined = body?.record?.id;

  // The webhook fires on the run, so the job may not exist yet.
  if (insertedRunId && !explicitJob) {
    await supabase.rpc('enqueue_verification', { p_run_id: insertedRunId });
  }

  /*
   * Claim atomically. A conditional UPDATE rather than a select-then-update: two invocations racing on a select would
   * both replay the same slice, doubling CPU use and racing to commit.
   */
  const claim = await supabase.rpc('claim_verification_job', { p_lease_seconds: LEASE_SECONDS });
  if (claim.error) {
    return Response.json({ error: 'claim_failed', detail: claim.error.message }, { status: 500 });
  }

  const job = Array.isArray(claim.data) ? claim.data[0] : null;
  if (!job) {
    // Nothing claimable. Not an error: another invocation has it, or the queue is empty.
    return Response.json({ ok: true, claimed: false });
  }

  const jobId = job.job_id as string;
  const runId = job.run_id as string;

  try {
    const runResult = await supabase
      .from('runs')
      .select(
        'id, player_id, map_id, mode_id, claimed_score, claimed_summary, log_path, sim_version',
      )
      .eq('id', runId)
      .single();
    if (runResult.error) throw new Error(`run not found: ${runResult.error.message}`);
    const run = runResult.data;

    /*
     * Version check before any work. A run recorded under an older SIM_VERSION cannot be replayed by this build and
     * must not be: the replay would diverge immediately and reject an honest player for a change we made.
     */
    if (run.sim_version !== SIM_VERSION) {
      await supabase.rpc('reject_run', {
        p_run_id: runId,
        p_reason: 'unsupported_version',
        p_first_mismatch_tick: null,
      });
      return Response.json({ ok: true, verdict: 'rejected', reason: 'unsupported_version' });
    }

    const log = await fetchLog(supabase, run.log_path as string);
    const content = contentForRun(log);

    const slice = replaySlice({
      log,
      content,
      state: job.state ? fromBase64(job.state as string) : null,
      cursorTick: job.cursor_tick as number,
      maxTicks: SLICE_TICKS,
      // Checked after restore, so a serialisation defect is reported as itself rather than as a replay mismatch.
      expectedResumeHash: (job.resume_hash as string | null) ?? undefined,
    });

    // A checkpoint disagreed. The tick is recorded so an honest bug can be distinguished from tampering.
    if (slice.mismatchTick !== null) {
      await supabase.rpc('reject_run', {
        p_run_id: runId,
        p_reason: 'replay_mismatch',
        p_first_mismatch_tick: slice.mismatchTick,
      });
      return Response.json({
        ok: true,
        verdict: 'rejected',
        reason: 'replay_mismatch',
        tick: slice.mismatchTick,
      });
    }

    // More to do: persist and chain.
    if (!slice.done) {
      const slicesDone = (job.slices_done as number) + 1;

      /*
       * Budget check. Without it a malformed or adversarial log could keep the chain alive indefinitely and consume the
       * monthly invocation quota.
       */
      if (slicesDone >= (job.max_slices as number)) {
        await supabase.rpc('reject_run', {
          p_run_id: runId,
          p_reason: 'verifier_error',
          p_first_mismatch_tick: null,
        });
        return Response.json({ ok: true, verdict: 'rejected', reason: 'slice_budget_exceeded' });
      }

      await supabase
        .from('verification_jobs')
        .update({
          cursor_tick: slice.cursorTick,
          state: slice.state ? toBase64(slice.state) : null,
          // The hash the NEXT slice checks after restoring, which is how a bad round trip is caught early.
          resume_hash: slice.checkpoints.at(-1)?.hash ?? null,
          slices_done: slicesDone,
          // Release the lease immediately: the chained call should be able to claim at once.
          claimed_until: null,
          last_error: null,
        })
        .eq('id', jobId);

      await chain(jobId, secret);

      return Response.json({
        ok: true,
        verdict: 'continue',
        cursorTick: slice.cursorTick,
        slicesDone,
      });
    }

    // Finished. The replayed summary is the only one that counts.
    const verified = slice.summary;
    if (!verified) {
      throw new Error('replay completed without a summary');
    }

    const claimed = run.claimed_summary as RunLog['summary'];

    /*
     * The comparison the whole system exists for.
     *
     * A claim BELOW the replay is tolerated: a client that under-reports has not gained anything, and the verified
     * figure is what gets used regardless. A claim ABOVE it is rejected, because that is exactly what a tampered
     * client produces.
     */
    if (claimed.score > verified.score) {
      await supabase.rpc('reject_run', {
        p_run_id: runId,
        p_reason: 'score_mismatch',
        p_first_mismatch_tick: null,
      });
      return Response.json({
        ok: true,
        verdict: 'rejected',
        reason: 'score_mismatch',
        claimed: claimed.score,
        verified: verified.score,
      });
    }

    // The final state hash must also agree, which catches a log whose checkpoints pass but whose end state differs.
    if (claimed.finalHash !== verified.finalHash) {
      await supabase.rpc('reject_run', {
        p_run_id: runId,
        p_reason: 'replay_mismatch',
        p_first_mismatch_tick: verified.durationTicks,
      });
      return Response.json({ ok: true, verdict: 'rejected', reason: 'final_hash_mismatch' });
    }

    /*
     * Ghost promotion. Read the board first: whether this score is worth racing against depends on the current top of
     * the board, which only the server knows.
     */
    const board = await supabase.rpc('leaderboard', {
      p_map_id: run.map_id,
      p_mode_id: run.mode_id,
      p_period: 'all-time',
      p_limit: GHOST_RANK_LIMIT,
      p_offset: 0,
    });
    const entries = Array.isArray(board.data) ? board.data : [];
    const promote =
      entries.length < GHOST_RANK_LIMIT ||
      verified.score > Math.min(...entries.map((e: { score: number }) => e.score));

    const commit = await supabase.rpc('commit_verified_run', {
      p_run_id: runId,
      p_verified_score: verified.score,
      p_xp: xpForRun(verified),
      p_promote_ghost: promote,
    });
    if (commit.error) throw new Error(`commit failed: ${commit.error.message}`);

    // The job has served its purpose, and the state blob is the largest thing in the table.
    await supabase.from('verification_jobs').delete().eq('id', jobId);

    return Response.json({
      ok: true,
      verdict: 'verified',
      score: verified.score,
      result: commit.data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    /*
     * Release the lease and record why, rather than rejecting the run. A verifier fault is not the player's fault, so
     * the job stays claimable and the slice budget bounds how many times it can fail before giving up.
     */
    await supabase
      .from('verification_jobs')
      .update({ claimed_until: null, last_error: message })
      .eq('id', jobId);

    return Response.json({ error: 'verifier_error', detail: message }, { status: 500 });
  }
});
