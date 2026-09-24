/**
 * RecentRunsView: the player's latest runs and their verification status, in the account panel (WO-40).
 *
 * This is where a slow verdict lands. The Result Screen stops polling after ten minutes, and a player who has moved
 * on still needs to see whether a run counted (AC-VER-003.3, AC-VER-003.4). Reads `my_runs`, which returns only the
 * caller's rows and only player-facing columns.
 */

import '../results.css';
import { describeRejection } from '../net/run-status.js';
import { supabase } from '../net/supabase.js';

interface RecentRun {
  id: string;
  claimed_score: number;
  verified_score: number | null;
  status: string;
  rejection_reason: string | null;
  submitted_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Verifying',
  verified: 'Verified',
  rejected: 'Not counted',
  invalidated: 'Removed',
};

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text = '',
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** Fill a container with the last ten runs. Safe to call repeatedly; each call replaces the contents. */
export async function renderRecentRuns(container: HTMLElement): Promise<void> {
  container.replaceChildren();
  node('h3', 'recent-runs-title', container, 'Recent runs');
  const note = node('p', 'recent-runs-empty', container, 'Loading');

  if (!supabase) {
    note.textContent = 'Playing offline. Runs are not submitted.';
    return;
  }

  const { data, error } = await supabase.rpc('my_runs', { p_limit: 10 });
  if (error) {
    note.textContent = 'Could not load your runs. Try again later.';
    return;
  }

  const runs = (data ?? []) as RecentRun[];
  if (runs.length === 0) {
    note.textContent = 'No runs yet. Finish a round to see it here.';
    return;
  }

  note.remove();
  const list = node('ol', 'recent-runs-list', container);
  for (const run of runs) {
    const item = node('li', 'recent-run', list);
    item.dataset.status = run.status;
    // The verified score when there is one: the claim is only a claim until the replay agrees.
    node('span', 'recent-run-score', item, (run.verified_score ?? run.claimed_score).toLocaleString());
    node('span', 'recent-run-status', item, STATUS_LABEL[run.status] ?? run.status);
    const when = new Date(run.submitted_at).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    node('span', 'recent-run-when', item, when);
    if (run.status === 'rejected') {
      node('span', 'recent-run-reason', item, describeRejection(run.rejection_reason));
    }
  }
}
