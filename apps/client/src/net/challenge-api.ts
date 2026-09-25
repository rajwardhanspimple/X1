import { supabase } from './supabase.js';

export interface ChallengeDescriptor {
  challenge_id: string;
  challenge_date: string;
  map_id: string;
  mode_id: string;
  seed: number;
  sim_version: number;
  modifiers: Record<string, unknown>;
  opens_at: string;
  closes_at: string;
  attempt_used: boolean;
  attempt_started_at: string | null;
  result_score: number | null;
}

export interface ChallengeAttempt {
  challenge_id: string;
  challenge_date: string;
  map_id: string;
  mode_id: string;
  seed: number;
  sim_version: number;
  modifiers: Record<string, unknown>;
  opens_at: string;
  closes_at: string;
  attempt_started_at: string;
}

export interface ChallengeHistoryEntry {
  challenge_date: string;
  challenge_id: string;
  score: number;
  run_id: string | null;
  current_streak: number;
}

export interface ChallengeBoardRow {
  rank: number;
  player_id: string;
  display_name: string;
  avatar_id: string | null;
  country: string | null;
  score: number;
  achieved_at: string;
  run_id: string;
}

export async function getCurrentChallenge(): Promise<ChallengeDescriptor> {
  if (!supabase) throw new Error('Daily Challenge needs a server connection.');
  const { data, error } = await supabase.rpc('get_current_challenge');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Today's Challenge is not available yet.");
  return row as ChallengeDescriptor;
}

export async function startChallengeAttempt(challengeId: string): Promise<ChallengeAttempt> {
  if (!supabase) throw new Error('Daily Challenge needs a server connection.');
  const { data, error } = await supabase.rpc('start_challenge_attempt', {
    p_challenge_id: challengeId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('The Challenge attempt could not start.');
  return row as ChallengeAttempt;
}

export async function getChallengeHistory(limit = 30): Promise<ChallengeHistoryEntry[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('get_challenge_history', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as ChallengeHistoryEntry[];
}

export async function getChallengeBoard(
  challengeId: string,
  limit = 50,
  offset = 0,
): Promise<ChallengeBoardRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('get_challenge_leaderboard', {
    p_challenge_id: challengeId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return (data ?? []) as ChallengeBoardRow[];
}
