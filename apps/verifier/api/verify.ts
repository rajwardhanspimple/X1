import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/verify
 *
 * Invoked by a Supabase Database Webhook on INSERT into verification_jobs.
 * Implemented by WO-38: JobClaimer (conditional claim), ReplayVerifier (Sim Core ReplayRunner),
 * ResultCommitter (commit_verification RPC), VerifierMetricsSink.
 *
 * Contract (see RE:Arena Verifier blueprint):
 * - reject when x-verifier-secret does not match VERIFIER_WEBHOOK_SECRET
 * - claim with UPDATE ... WHERE status = 'queued' RETURNING; zero rows means already handled
 * - replay must stay under 2 s CPU for a 5 minute run
 * - always return 200 after a successful claim so the webhook does not retry a job we own
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const secret = process.env.VERIFIER_WEBHOOK_SECRET;
  if (!secret || req.headers['x-verifier-secret'] !== secret) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.status(501).json({ error: 'not_implemented', workOrder: 'WO-38' });
}
