/**
 * Leaderboard reads.
 *
 * Thin over the RPCs. Ranking, tie-breaks and the exclusion of hidden or flagged players all happen in Postgres, and
 * this file deliberately does none of it: a second implementation of the tie-break would eventually disagree with the
 * first, and the player would see their pinned rank differ from their row in the list.
 */

import { supabase } from './supabase.js';

export type BoardPeriod = 'all-time' | 'weekly' | 'daily';

export const BOARD_PERIODS: readonly BoardPeriod[] = ['all-time', 'weekly', 'daily'];

export function describePeriod(period: BoardPeriod): string {
  switch (period) {
    case 'all-time':
      return 'All time';
    case 'weekly':
      return 'This week';
    case 'daily':
      return 'Today';
  }
}

export interface BoardRow {
  rank: number;
  playerId: string;
  displayName: string;
  avatarId: string;
  country: string | null;
  level: number;
  score: number;
  achievedAt: string;
  runId: string;
  hasGhost: boolean;
}

export interface OwnRank {
  ranked: boolean;
  rank?: number;
  total?: number;
  score?: number;
  reason?: string;
}

export interface BoardPage {
  rows: BoardRow[];
  own: OwnRank;
  /** Null when the read succeeded. */
  error: string | null;
}

const PAGE_SIZE = 25;

/** Fetch one page, plus the caller's own standing. */
export async function fetchBoard(
  mapId: string,
  modeId: string,
  period: BoardPeriod,
  page = 0,
): Promise<BoardPage> {
  if (!supabase) {
    return { rows: [], own: { ranked: false, reason: 'offline' }, error: 'Playing offline.' };
  }

  try {
    /*
     * Both in parallel. The own-rank query is a separate RPC rather than a scan of the pages, because a player at rank
     * 4,000 would otherwise need eighty requests to find themselves.
     */
    const [boardResult, rankResult] = await Promise.all([
      supabase.rpc('leaderboard', {
        p_map_id: mapId,
        p_mode_id: modeId,
        p_period: period,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      }),
      supabase.rpc('my_rank', { p_map_id: mapId, p_mode_id: modeId, p_period: period }),
    ]);

    if (boardResult.error) throw boardResult.error;

    const rows: BoardRow[] = (boardResult.data ?? []).map(
      (r: Record<string, unknown>): BoardRow => ({
        // Taken as returned. Recomputing an index would number page two from 1.
        rank: Number(r.rank),
        playerId: String(r.player_id),
        displayName: String(r.display_name),
        avatarId: String(r.avatar_id ?? 'default'),
        country: (r.country as string | null) ?? null,
        level: Number(r.level ?? 1),
        score: Number(r.score),
        achievedAt: String(r.achieved_at),
        runId: String(r.run_id),
        hasGhost: Boolean(r.has_ghost),
      }),
    );

    const own: OwnRank = rankResult.error
      ? { ranked: false, reason: 'unavailable' }
      : ((rankResult.data as OwnRank) ?? { ranked: false });

    return { rows, own, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offline = /failed to fetch|networkerror|load failed|timeout/i.test(message);
    return {
      rows: [],
      own: { ranked: false, reason: 'error' },
      // A board that cannot load must not imply a lost run, so the message says where progress stands.
      error: offline
        ? 'Could not reach the leaderboard. Your runs are safe.'
        : 'Could not load the leaderboard.',
    };
  }
}

export { PAGE_SIZE as BOARD_PAGE_SIZE };

/** Recent own runs and their verification state, for the profile and results screens. */
export interface MyRun {
  id: string;
  mapId: string;
  modeId: string;
  claimedScore: number;
  verifiedScore: number | null;
  status: 'pending' | 'verified' | 'rejected' | 'invalidated';
  rejectionReason: string | null;
  submittedAt: string;
  verifiedAt: string | null;
}

export async function fetchMyRuns(limit = 20): Promise<MyRun[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('my_runs', { p_limit: limit });
  if (error || !Array.isArray(data)) return [];

  return data.map((r: Record<string, unknown>): MyRun => ({
    id: String(r.id),
    mapId: String(r.map_id),
    modeId: String(r.mode_id),
    claimedScore: Number(r.claimed_score),
    verifiedScore: r.verified_score === null ? null : Number(r.verified_score),
    status: r.status as MyRun['status'],
    rejectionReason: (r.rejection_reason as string | null) ?? null,
    submittedAt: String(r.submitted_at),
    verifiedAt: (r.verified_at as string | null) ?? null,
  }));
}

/** Player-facing explanation of a verification state. */
export function describeRunStatus(run: MyRun): string {
  switch (run.status) {
    case 'pending':
      return 'Checking...';
    case 'verified':
      return `Verified: ${run.verifiedScore?.toLocaleString() ?? '0'}`;
    case 'rejected':
      /*
       * Named specifically. "Rejected" alone would leave an honest player whose run hit a verifier bug with no way to
       * tell that from being accused of cheating.
       */
      return run.rejectionReason === 'unsupported_version'
        ? 'Not counted: the game updated after this run'
        : run.rejectionReason === 'score_mismatch'
          ? 'Not counted: the score did not match the replay'
          : run.rejectionReason === 'replay_mismatch'
            ? 'Not counted: the replay did not match'
            : 'Not counted';
    case 'invalidated':
      return 'Removed from the boards';
  }
}

/** Progression state: XP, level, and every unlock with its requirement. */
export interface ProgressionItem {
  itemType: string;
  itemId: string;
  displayName: string;
  requiredLevel: number;
  unlocked: boolean;
}

export interface Progression {
  signedIn: boolean;
  xp?: number;
  level?: number;
  nextLevel?: number | null;
  nextLevelXp?: number | null;
  items?: ProgressionItem[];
}

export async function fetchProgression(): Promise<Progression> {
  if (!supabase) return { signedIn: false };
  const { data, error } = await supabase.rpc('progression_state');
  if (error || !data) return { signedIn: false };
  return data as Progression;
}
