import { supabase } from './supabase.js';
import type { BoardRow } from './board-cache.js';

export interface BoardPeriodRange {
  id: string;
  name: string;
  start: string;
  end: string;
  simVersion: number;
}
export interface SeasonalRow extends BoardRow {
  seasonName: string;
}
export interface SeasonalPage {
  rows: SeasonalRow[];
  total: number;
  range: BoardPeriodRange | null;
}
export function formatPeriodRange(start: string, end: string): string {
  const format = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${format.format(new Date(start))} – ${format.format(new Date(end))}`;
}
function mapRow(row: Record<string, unknown>): BoardRow {
  return {
    rank: Number(row.rank),
    playerId: String(row.player_id),
    displayName: String(row.display_name),
    score: Number(row.score),
    achievedAt: String(row.achieved_at),
    runId: String(row.run_id),
    simVersion: Number(row.sim_version),
    hasGhost: Boolean(row.has_ghost),
    accuracyBp: row.accuracy_bp == null ? null : Number(row.accuracy_bp),
  };
}
async function readBoard(
  functionName: string,
  mapId: string,
  modeId: string,
  offset: number,
  extra: Record<string, unknown> = {},
): Promise<SeasonalPage> {
  const { data, error } = await supabase.rpc(functionName, {
    p_map_id: mapId,
    p_mode_id: modeId,
    p_limit: 50,
    p_offset: offset,
    ...extra,
  });
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  const range = rows[0]?.period_start
    ? {
        id: String(rows[0].period_start),
        name: String(rows[0].season_name ?? 'Archived board'),
        start: String(rows[0].period_start),
        end: String(rows[0].period_end ?? rows[0].period_start),
        simVersion: Number(rows[0].sim_version),
      }
    : null;
  return {
    rows: rows.map((row) => ({ ...mapRow(row), seasonName: String(row.season_name ?? '') })),
    total: Number(rows[0]?.total_count ?? rows.length),
    range,
  };
}
export function fetchSeasonalBoard(mapId: string, modeId: string, offset: number): Promise<SeasonalPage> {
  return readBoard('seasonal_leaderboard', mapId, modeId, offset);
}
export function fetchArchivedBoard(
  mapId: string,
  modeId: string,
  period: BoardPeriodRange,
  offset: number,
): Promise<SeasonalPage> {
  return readBoard('archived_leaderboard', mapId, modeId, offset, {
    p_period: period.id,
    p_sim_version: period.simVersion,
  });
}
export async function listArchivedPeriods(mapId: string, modeId: string): Promise<BoardPeriodRange[]> {
  const { data, error } = await supabase.rpc('list_archived_periods', {
    p_map_id: mapId,
    p_mode_id: modeId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.period_start),
    name: String(row.period_name ?? row.period_start),
    start: String(row.period_start),
    end: String(row.period_end),
    simVersion: Number(row.sim_version),
  }));
}
