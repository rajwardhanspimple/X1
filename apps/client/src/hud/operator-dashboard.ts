import { supabase } from '../net/supabase.js';

export type RejectionRate = { client_version: string; device_class: string; rejection_reason: string | null; total: number; rejected: number; rate: number };
export const REJECTION_REASONS = ['replay_mismatch', 'unsupported_version', 'malformed_log', 'duplicate'] as const;

export function formatRate(rate: number, total: number): string {
  if (total <= 0) return 'No runs';
  return `${(rate * 100).toFixed(1)}% (${total.toLocaleString()} runs)`;
}
export function emptyState(rows: readonly RejectionRate[]): string | null { return rows.length === 0 ? 'No verification runs in the last 30 days.' : null; }

export class OperatorDashboard {
  private readonly root: HTMLElement;
  private rows: RejectionRate[] = [];
  constructor(root: HTMLElement) { this.root = root; }
  async load(): Promise<void> {
    if (!supabase) { this.root.textContent = 'Operator console is offline.'; return; }
    const { data, error } = await supabase.from('verifier_rejection_rates').select('*').order('client_version');
    if (error) { this.root.textContent = `Unable to load verification health: ${error.message}`; return; }
    this.rows = (data ?? []) as RejectionRate[];
    this.render();
  }
  render(): void {
    this.root.replaceChildren();
    const title = document.createElement('h2'); title.textContent = 'Operator dashboard'; this.root.append(title);
    const empty = emptyState(this.rows); if (empty) { const p = document.createElement('p'); p.textContent = empty; this.root.append(p); return; }
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Client version</th><th>Device class</th><th>Reason</th><th>Rate</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const row of this.rows) { const tr = document.createElement('tr'); for (const value of [row.client_version, row.device_class, row.rejection_reason ?? 'All', formatRate(row.rate, row.total)]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); } body.append(tr); }
    table.append(body); this.root.append(table);
  }
  async invalidateRun(runId: string, reason: string): Promise<void> { if (!supabase || !reason.trim()) return; const { error } = await supabase.rpc('invalidate_run', { run_id: runId, reason_code: reason.trim() }); if (error) throw error; await this.load(); }
  async setPlayerFlag(playerId: string, on: boolean, note: string): Promise<void> { if (!supabase || !note.trim()) return; const { error } = await supabase.rpc('set_player_flag', { player_id: playerId, on, note: note.trim() }); if (error) throw error; }
}
