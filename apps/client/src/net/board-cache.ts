/**
 * BoardCache: leaderboard pages and the player's own rank, cached per board and page (WO-43).
 *
 * Stale-while-revalidate. A cached page is shown at once and refreshed when it is older than FRESH_MS. A failed
 * refresh keeps the cached page on screen with a notice rather than blanking the board (AC-LDB-005.2, AC-LDB-005.3).
 *
 * Rank comes from the server (the leaderboard and my_rank RPCs). A client that numbered rows itself could not know how
 * many rows precede page two.
 */

import { SIM_VERSION } from '@rearena/sim';
import { supabase } from './supabase.js';

export type BoardPeriod = 'all-time' | 'weekly' | 'daily';

export const BOARD_PERIODS: readonly BoardPeriod[] = ['all-time', 'weekly', 'daily'];

/** Rows per page. */
export const PAGE_SIZE = 20;

/** A cached page younger than this is shown without a refresh. */
const FRESH_MS = 30_000;

export interface BoardSelection {
  mapId: string;
  modeId: string;
  period: BoardPeriod;
}

export interface BoardRow {
  rank: number;
  playerId: string;
  displayName: string;
  score: number;
  /** Basis points, 10000 = 100%. Null for a run recorded without it. */
  accuracyBp: number | null;
  achievedAt: string;
  runId: string;
  simVersion: number;
  hasGhost: boolean;
}

export interface BoardPage {
  rows: BoardRow[];
  /** Entries on the whole board, not only this page. */
  total: number;
  offset: number;
  fetchedAt: number;
}

export type NoRankReason = 'no_entry' | 'not_signed_in' | 'hidden' | 'unknown';

export type MyRankResult =
  | { kind: 'ranked'; rank: number; total: number; row: BoardRow }
  | { kind: 'none'; reason: NoRankReason };

interface RawRow {
  rank: number | string;
  player_id: string;
  display_name: string;
  score: number;
  accuracy_bp: number | null;
  achieved_at: string;
  run_id: string;
  sim_version: number;
  has_ghost: boolean;
  total: number | string;
}

interface RawRank {
  ranked?: boolean;
  reason?: string;
  rank?: number;
  total?: number;
  score?: number;
  achievedAt?: string;
  playerId?: string;
  displayName?: string;
  runId?: string;
  simVersion?: number;
  accuracyBp?: number | null;
  hasGhost?: boolean;
}

/** The cache key. Includes the simulation version so a new build never shows an old build's cached page. */
export function boardKey(selection: BoardSelection): string {
  return `${selection.mapId}:${selection.modeId}:${selection.period}:${SIM_VERSION}`;
}

function toRow(raw: RawRow): BoardRow {
  return {
    rank: Number(raw.rank),
    playerId: raw.player_id,
    displayName: raw.display_name,
    score: raw.score,
    accuracyBp: raw.accuracy_bp,
    achievedAt: raw.achieved_at,
    runId: raw.run_id,
    simVersion: raw.sim_version,
    hasGhost: raw.has_ghost,
  };
}

function reasonOf(reason: string | undefined): NoRankReason {
  if (reason === 'no_entry' || reason === 'not_signed_in' || reason === 'hidden') return reason;
  return 'unknown';
}

export class BoardCache {
  private readonly pages = new Map<string, BoardPage>();

  private pageKey(selection: BoardSelection, offset: number): string {
    return `${boardKey(selection)}@${offset}`;
  }

  cached(selection: BoardSelection, offset: number): BoardPage | null {
    return this.pages.get(this.pageKey(selection, offset)) ?? null;
  }

  isFresh(page: BoardPage): boolean {
    return Date.now() - page.fetchedAt < FRESH_MS;
  }

  /** Fetch one page and cache it. Throws when the request fails, so the caller can keep what it had. */
  async fetchPage(selection: BoardSelection, offset: number): Promise<BoardPage> {
    if (!supabase) throw new Error('No connection to the server.');
    const { data, error } = await supabase.rpc('leaderboard', {
      p_map_id: selection.mapId,
      p_mode_id: selection.modeId,
      p_period: selection.period,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (error) throw new Error(error.message);

    const raw = (data ?? []) as RawRow[];
    const first = raw[0];
    const page: BoardPage = {
      rows: raw.map(toRow),
      // Every row carries the board total. An empty page past the first cannot say, so it reports its own offset.
      total: first ? Number(first.total) : offset,
      offset,
      fetchedAt: Date.now(),
    };
    this.pages.set(this.pageKey(selection, offset), page);
    return page;
  }

  /** The player's own standing on a board, or why there is none. Never throws. */
  async fetchMyRank(selection: BoardSelection): Promise<MyRankResult> {
    if (!supabase) return { kind: 'none', reason: 'not_signed_in' };
    const { data, error } = await supabase.rpc('my_rank', {
      p_map_id: selection.mapId,
      p_mode_id: selection.modeId,
      p_period: selection.period,
    });
    const raw = data as RawRank | null;
    if (error || !raw) return { kind: 'none', reason: 'unknown' };
    if (raw.ranked !== true || raw.rank === undefined || raw.total === undefined) {
      return { kind: 'none', reason: reasonOf(raw.reason) };
    }

    const rank = Number(raw.rank);
    return {
      kind: 'ranked',
      rank,
      total: Number(raw.total),
      row: {
        rank,
        playerId: raw.playerId ?? '',
        displayName: raw.displayName ?? 'You',
        score: raw.score ?? 0,
        accuracyBp: raw.accuracyBp ?? null,
        achievedAt: raw.achievedAt ?? '',
        runId: raw.runId ?? '',
        simVersion: raw.simVersion ?? 0,
        hasGhost: raw.hasGhost ?? false,
      },
    };
  }

  /** Drop every cached page. Called after a run verifies, since any board may have changed. */
  invalidate(): void {
    this.pages.clear();
  }
}
