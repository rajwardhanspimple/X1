// verify-run: the RE:Arena Verifier as a Supabase Edge Function (Deno).
//
// Free-plan constraint: 2 s CPU per invocation. A 5 minute run is ~2 s of replay, so one run is
// verified across a chain of invocations. Each call:
//   1. checks x-verifier-secret
//   2. claims or resumes the verification_jobs row (conditional UPDATE with a 30 s lock window)
//   3. restores SimState from job.sim_state (or starts at tick 0), replays up to SLICE_TICKS,
//      comparing checkpoint hashes as they pass
//   4a. if ticks remain: persists sim_state + cursor_tick and calls advance_verification(job_id),
//       which re-posts to this function via pg_net
//   4b. if done: calls commit_verification(job_id, outcome) and writes a verifier_metrics row
//
// Implemented by WO-38. Sim Core serialisation and replaySlice come from WO-19.
// See blueprint: RE:Arena Verifier.

import { createClient } from '@supabase/supabase-js';

const SLICE_TICKS = Number(Deno.env.get('VERIFIER_SLICE_TICKS') ?? '6000');

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

  // Payload is either a Database Webhook envelope ({ type, table, record }) for slice 0
  // or { job_id } from advance_verification for later slices.
  const body = await req.json().catch(() => null);
  const jobId: string | undefined = body?.record?.id ?? body?.job_id;
  if (!jobId) {
    return Response.json({ error: 'malformed_payload' }, { status: 400 });
  }

  void supabase;
  void SLICE_TICKS;
  return Response.json({ error: 'not_implemented', workOrder: 'WO-38', jobId }, { status: 501 });
});
