/**
 * RunStatusTracker: follow one submitted run from the server's first sight of it to a verdict.
 *
 * The verifier runs as a chain of Edge Function invocations, so a three-minute run takes a few seconds to settle and
 * can take longer when the platform is slow. The Result Screen needs to show that time honestly: pending, then
 * "still verifying" past a threshold, then the verdict. This polls the player's own `runs` row, which row-level security
 * already restricts to them, rather than subscribing to realtime changes: one small select every few seconds costs
 * less than a realtime channel on the free tier, and it needs no extra configuration.
 *
 * Polling backs off and stops after ten minutes. A run still pending by then is not lost; the account panel lists it
 * with its status, which is where AC-VER-003.3 sends a delayed outcome.
 */

import { supabase } from './supabase.js';

/** What the Result Screen should say about a run the server has accepted. */
export type RunStatusView =
  | { kind: 'pending' }
  | { kind: 'slow' }
  | { kind: 'deferred' }
  | { kind: 'verified'; score: number; rank: number | null; total: number | null }
  | { kind: 'rejected'; reason: string };

/** After this, the screen says "still verifying" instead of pending (AC-VER-003.2). */
export const STILL_VERIFYING_MS = 60_000;

/** After this, polling stops and the account panel takes over. */
export const STOP_POLLING_MS = 10 * 60_000;

/** Poll delays. Short at first, because a healthy run settles within about ten seconds. */
const POLL_STEPS_MS = [2000, 3000, 5000, 8000, 15000, 30000, 60000];

interface RunRow {
  status: string;
  rejection_reason: string | null;
  verified_score: number | null;
  map_id: string;
  mode_id: string;
}

/**
 * One player-facing sentence per rejection category.
 *
 * Categories only. The first mismatch tick and the log path stay server-side (AC-VER-002.4): they help an operator tell
 * a bug from tampering, and they would help a cheater tune a forged log.
 */
export function describeRejection(reason: string | null): string {
  switch (reason) {
    case 'unsupported_version':
      return 'Not counted: this run was recorded on an older version of the game. Reload the page before your next round.';
    case 'replay_mismatch':
    case 'score_mismatch':
      return 'Not counted: the replay of this run did not match its result.';
    case 'malformed':
      return 'Not counted: the run data was incomplete.';
    case 'duplicate':
      return 'Not counted: this run was already submitted.';
    case 'verifier_error':
      return 'Not counted: the server could not check this run. This is not your fault.';
    default:
      return 'Not counted: this run could not be verified.';
  }
}

async function readRun(clientRunId: string): Promise<RunRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('runs')
    .select('status, rejection_reason, verified_score, map_id, mode_id')
    .eq('client_run_id', clientRunId)
    .maybeSingle();
  if (error) return null;
  return (data as RunRow | null) ?? null;
}

/** The player's best standing on the all-time board, for the verified line. Null when it cannot be read. */
async function readRank(
  mapId: string,
  modeId: string,
): Promise<{ rank: number; total: number } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('my_rank', {
    p_map_id: mapId,
    p_mode_id: modeId,
    p_period: 'all-time',
  });
  const result = data as { ranked?: boolean; rank?: number; total?: number } | null;
  if (error || !result || result.ranked !== true) return null;
  return { rank: Number(result.rank), total: Number(result.total) };
}

export class RunStatusTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every follow and stop, so a poll that resolves late cannot report on a run nobody is watching. */
  private generation = 0;

  constructor(private readonly onChange: (view: RunStatusView) => void) {}

  /** Follow a run the server has accepted, until it settles or the time limit passes. */
  follow(clientRunId: string, startedAt = Date.now()): void {
    this.stop();
    const generation = this.generation;
    let step = 0;
    this.onChange({ kind: 'pending' });

    const poll = async (): Promise<void> => {
      if (generation !== this.generation) return;
      const elapsed = Date.now() - startedAt;
      const row = await readRun(clientRunId);
      if (generation !== this.generation) return;

      if (row?.status === 'verified') {
        const rank = await readRank(row.map_id, row.mode_id);
        if (generation !== this.generation) return;
        this.onChange({
          kind: 'verified',
          score: row.verified_score ?? 0,
          rank: rank?.rank ?? null,
          total: rank?.total ?? null,
        });
        return;
      }

      if (row?.status === 'rejected' || row?.status === 'invalidated') {
        this.onChange({ kind: 'rejected', reason: describeRejection(row.rejection_reason) });
        return;
      }

      if (elapsed >= STOP_POLLING_MS) {
        this.onChange({ kind: 'deferred' });
        return;
      }

      // A failed read (row null) is treated as still pending: a dropped request is not a verdict.
      this.onChange(elapsed >= STILL_VERIFYING_MS ? { kind: 'slow' } : { kind: 'pending' });
      const delay = POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)]!;
      step += 1;
      this.timer = setTimeout(() => void poll(), delay);
    };

    this.timer = setTimeout(() => void poll(), POLL_STEPS_MS[0]);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
