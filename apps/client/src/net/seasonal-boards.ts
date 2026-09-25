import { supabase } from './supabase.js';

export type PeriodKind = 'season' | 'archive';
export interface BoardPeriodRange { id: string; name: string; period: string; start: string; end: string; simVersion: number; entryCount: number; }
export interface SeasonalRow { rank: number; playerId: string; displayName: string; score: number; accuracyBp: number | null; achievedAt: string; runId: string; simVersion: number; hasGhost: boolean; }
export interface SeasonalPage { rows: SeasonalRow[]; total: number; offset: number; range: BoardPeriodRange | null; }

export function formatPeriodRange(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  return `${new Date(start).toLocaleString(undefined, opts)} to ${new Date(end).toLocaleString(undefined, opts)}`;
}

export async function fetchSeasonalBoard(mapId: string, modeId: string, offset = 0): Promise<SeasonalPage> {
  if (!supabase) return { rows: [], total: 0, offset, range: null };
  const { data: season, error: seasonError } = await supabase.rpc('current_season');
  if (seasonError) throw seasonError;
  if (!season) return { rows: [], total: 0, offset, range: null };
  const { data, error } = await supabase.rpc('seasonal_leaderboard', { p_map_id: mapId, p_mode_id: modeId, p_season_id: season.id, p_limit: 20, p_offset: offset });
  if (error) throw error;
  const rows = (data ?? []).map((r: Record<string, unknown>, i: number) => ({ rank: Number(r.rank ?? offset+i+1), playerId: String(r.player_id), displayName: String(r.display_name ?? 'Player'), score: Number(r.score), accuracyBp: r.accuracy_bp == null ? null : Number(r.accuracy_bp), achievedAt: String(r.achieved_at), runId: String(r.run_id), simVersion: Number(r.sim_version), hasGhost: Boolean(r.has_ghost) }));
  return { rows, total: Number((data?.[0] as Record<string, unknown> | undefined)?.total ?? rows.length), offset, range: { id: String(season.id), name: String(season.name), period: 'season', start: String(season.starts_at), end: String(season.ends_at), simVersion: Number(rows[0]?.simVersion ?? 0), entryCount: rows.length } };
}

export async function listArchivedPeriods(mapId: string, modeId: string): Promise<BoardPeriodRange[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('list_archived_periods', { p_map_id: mapId, p_mode_id: modeId });
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({ id: `${r.period}:${r.period_start}:${r.sim_version}`, name: `${String(r.period)} ${String(r.period_start)} v${String(r.sim_version)}`, period: String(r.period), start: String(r.period_start), end: String(r.period_end), simVersion: Number(r.sim_version), entryCount: Number(r.entry_count) }));
}

export async function fetchArchivedBoard(mapId: string, modeId: string, archive: BoardPeriodRange, offset = 0): Promise<SeasonalPage> {
  if (!supabase) return { rows: [], total: 0, offset, range: archive };
  const { data, error } = await supabase.rpc('archived_leaderboard', { p_map_id: mapId, p_mode_id: modeId, p_period: archive.period, p_period_start: archive.start, p_sim_version: archive.simVersion, p_limit: 20, p_offset: offset });
  if (error) throw error;
  const rows = (data ?? []).map((r: Record<string, unknown>) => ({ rank: Number(r.rank), playerId: String(r.player_id), displayName: String(r.display_name ?? 'Player'), score: Number(r.score), accuracyBp: r.accuracy_bp == null ? null : Number(r.accuracy_bp), achievedAt: String(r.achieved_at), runId: String(r.run_id), simVersion: Number(r.sim_version), hasGhost: Boolean(r.has_ghost) }));
  return { rows, total: Number((data?.[0] as Record<string, unknown> | undefined)?.total ?? rows.length), offset, range: archive };
}
