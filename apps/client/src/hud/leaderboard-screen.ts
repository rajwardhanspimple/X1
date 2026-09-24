/**
 * LeaderboardScreen (WO-43): browse verified boards by arena, mode and period, find your own rank, and pick a ghost.
 *
 * A self-contained overlay rather than a round state, like the account panel: opening a board does not start, pause or
 * end a round, so it has no place in the round state machine.
 *
 * Every data state is named on screen (AC-LDB-001.5, REQ-LDB-005): loading, saved results while updating, could not
 * refresh with the saved page kept, failed with nothing to show, and empty. Retry is offered whenever a request failed,
 * and a failure never resets the selection.
 */

import '../leaderboard.css';
import { SIM_VERSION } from '@rearena/sim';
import {
  BOARD_PERIODS,
  BoardCache,
  PAGE_SIZE,
  type BoardPage,
  type BoardPeriod,
  type BoardRow,
  type BoardSelection,
  type MyRankResult,
  type NoRankReason,
} from '../net/board-cache.js';
import { isBackendConfigured } from '../net/supabase.js';

export interface BoardOption {
  id: string;
  name: string;
}

/** What a ghost race needs to replay the right run under the right rules (AC-LDB-004.3). */
export interface GhostLaunch {
  runId: string;
  mapId: string;
  modeId: string;
  simVersion: number;
  playerName: string;
  score: number;
}

export interface LeaderboardScreenOptions {
  maps: readonly BoardOption[];
  modes: readonly BoardOption[];
  onGhost(launch: GhostLaunch): void;
}

const PERIOD_LABEL: Record<BoardPeriod, string> = {
  'all-time': 'All time',
  weekly: 'This week',
  daily: 'Today',
};

/** AC-LDB-005.4 and friends: say why there is no pinned row. */
const NO_RANK: Record<NoRankReason, string> = {
  no_entry: 'You have no result on this board yet.',
  not_signed_in: 'Play as a guest or sign in to appear on the boards.',
  hidden: 'Your results are hidden from the boards.',
  unknown: 'Your rank could not be loaded.',
};

type DataState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: BoardPage; refreshing: boolean }
  | { kind: 'failed'; message: string; page: BoardPage | null };

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function formatAccuracy(bp: number | null): string {
  return bp === null ? '-' : `${(bp / 100).toFixed(1)}%`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export class LeaderboardScreen {
  private readonly root: HTMLElement;
  private readonly periodTabs: HTMLElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly pinned: HTMLElement;
  private readonly pageLabel: HTMLElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly cache = new BoardCache();

  private selection: BoardSelection;
  private offset = 0;
  private data: DataState = { kind: 'loading' };
  private myRank: MyRankResult | null = null;
  /** Bumped per load, so a slow response for an old selection cannot overwrite a newer one. */
  private request = 0;
  private returnFocus: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly options: LeaderboardScreenOptions,
  ) {
    this.selection = {
      mapId: options.maps[0]?.id ?? '',
      modeId: options.modes[0]?.id ?? '',
      // AC-LDB-001.1: all-time by default.
      period: 'all-time',
    };

    this.root = node('div', 'lb-overlay', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Leaderboards');

    const panel = node('div', 'lb-panel', this.root);
    const header = node('div', 'lb-header', panel);
    node('h2', 'lb-title', header, 'Leaderboards');
    this.button(header, 'Close', () => this.close());

    const controls = node('div', 'lb-controls', panel);
    this.select(controls, 'Arena', options.maps, this.selection.mapId, (id) => {
      this.selection = { ...this.selection, mapId: id };
      this.reset();
    });
    this.select(controls, 'Mode', options.modes, this.selection.modeId, (id) => {
      this.selection = { ...this.selection, modeId: id };
      this.reset();
    });
    this.periodTabs = node('div', 'lb-periods', panel);

    this.status = node('p', 'lb-status', panel);
    this.status.setAttribute('role', 'status');

    const wrap = node('div', 'lb-table-wrap', panel);
    const table = node('table', 'lb-table', wrap);
    const head = node('thead', '', table);
    const headRow = node('tr', '', head);
    for (const label of ['Rank', 'Player', 'Score', 'Accuracy', 'Achieved', 'Replay']) {
      node('th', '', headRow, label);
    }
    this.body = node('tbody', '', table);

    this.pinned = node('div', 'lb-pinned', panel);

    const pager = node('div', 'lb-pager', panel);
    this.prevButton = this.button(pager, 'Previous', () => this.goTo(this.offset - PAGE_SIZE));
    this.pageLabel = node('span', 'lb-page-label', pager);
    this.nextButton = this.button(pager, 'Next', () => this.goTo(this.offset + PAGE_SIZE));
    this.jumpButton = this.button(pager, 'Jump to my rank', () => this.jumpToMine());

    this.note = node('p', 'lb-note', panel);

    this.root.addEventListener('keydown', (event) => {
      // Keys typed here belong to the board. Without this, Enter on a focused button also reaches the window
      // listener that starts a round.
      event.stopPropagation();
      if (event.key === 'Escape') this.close();
    });

    this.renderPeriods();
    this.render();
  }

  open(): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    this.note.textContent = '';
    void this.load();
    this.periodTabs.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.request += 1;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Shown under the board, for things like a ghost pick that cannot be acted on yet. */
  setNote(text: string): void {
    this.note.textContent = text;
  }

  /** Drop cached pages, for example after a run verifies. Reloads if the board is open. */
  invalidate(): void {
    this.cache.invalidate();
    if (this.isOpen()) void this.load();
  }

  dispose(): void {
    this.request += 1;
    this.root.remove();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const el = node('button', 'screen-button screen-button-compact', parent, label);
    el.type = 'button';
    el.addEventListener('click', onClick);
    return el;
  }

  private select(
    parent: HTMLElement,
    label: string,
    choices: readonly BoardOption[],
    value: string,
    onChange: (id: string) => void,
  ): void {
    const field = node('label', 'lb-field', parent, label);
    const select = node('select', 'lb-select', field);
    for (const choice of choices) {
      const option = node('option', '', select, choice.name);
      option.value = choice.id;
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
  }

  private renderPeriods(): void {
    this.periodTabs.replaceChildren();
    for (const period of BOARD_PERIODS) {
      const selected = this.selection.period === period;
      const tab = this.button(this.periodTabs, PERIOD_LABEL[period], () => {
        if (this.selection.period === period) return;
        this.selection = { ...this.selection, period };
        this.renderPeriods();
        this.reset();
      });
      tab.dataset.selected = String(selected);
      tab.setAttribute('aria-pressed', String(selected));
    }
  }

  /** A new board: back to the first page, and the old rank no longer applies. */
  private reset(): void {
    this.offset = 0;
    this.myRank = null;
    this.note.textContent = '';
    void this.load();
  }

  private goTo(offset: number): void {
    this.offset = Math.max(0, offset);
    void this.load();
  }

  /** AC-LDB-002.6: show the page that holds the player's entry. */
  private jumpToMine(): void {
    const mine = this.myRank;
    if (mine?.kind !== 'ranked') return;
    this.goTo(Math.floor((mine.rank - 1) / PAGE_SIZE) * PAGE_SIZE);
  }

  private async load(): Promise<void> {
    const request = ++this.request;

    if (!isBackendConfigured()) {
      this.data = {
        kind: 'failed',
        message: 'Leaderboards need a connection to the server. Playing offline.',
        page: null,
      };
      this.myRank = null;
      this.render(false);
      return;
    }

    const selection = { ...this.selection };
    const offset = this.offset;
    const cached = this.cache.cached(selection, offset);
    const fresh = cached !== null && this.cache.isFresh(cached);
    this.data = cached ? { kind: 'ready', page: cached, refreshing: !fresh } : { kind: 'loading' };
    this.render();

    void this.loadRank(request, selection);
    if (fresh) return;

    try {
      const page = await this.cache.fetchPage(selection, offset);
      if (request !== this.request) return;
      this.data = { kind: 'ready', page, refreshing: false };
    } catch (error) {
      if (request !== this.request) return;
      console.info(
        '[rearena] leaderboard load failed:',
        error instanceof Error ? error.message : error,
      );
      this.data = { kind: 'failed', message: 'Could not load the board.', page: cached };
    }
    this.render();
  }

  private async loadRank(request: number, selection: BoardSelection): Promise<void> {
    const rank = await this.cache.fetchMyRank(selection);
    if (request !== this.request) return;
    this.myRank = rank;
    this.renderMine();
  }

  private currentPage(): BoardPage | null {
    const data = this.data;
    if (data.kind === 'ready') return data.page;
    if (data.kind === 'failed') return data.page;
    return null;
  }

  private render(online = true): void {
    this.renderStatus(online);
    this.renderPager();
    this.renderMine();
  }

  private renderStatus(online: boolean): void {
    this.status.replaceChildren();
    const data = this.data;
    let text: string;
    let tone: 'neutral' | 'warn' | 'bad' = 'neutral';
    let retry = false;

    if (data.kind === 'loading') {
      text = 'Loading entries. They are not ready yet.';
    } else if (data.kind === 'ready') {
      if (data.refreshing) {
        text = 'Showing saved results while updating. They may not be current.';
        tone = 'warn';
      } else if (data.page.rows.length === 0) {
        text =
          data.page.offset === 0 ? 'No verified results on this board yet.' : 'No more entries.';
      } else {
        const total = data.page.total;
        text = `${total.toLocaleString()} ${total === 1 ? 'player' : 'players'} on this board.`;
      }
    } else {
      tone = data.page ? 'warn' : 'bad';
      retry = online;
      text = data.page ? 'Could not refresh. These results may not be current.' : data.message;
    }

    this.status.dataset.tone = tone;
    node('span', '', this.status, text);
    if (retry) this.button(this.status, 'Retry', () => void this.load());
  }

  private renderPager(): void {
    const page = this.currentPage();
    const total = page?.total ?? 0;
    const current = Math.floor(this.offset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE), current);
    this.pageLabel.textContent = `Page ${current} of ${pages}`;
    this.prevButton.disabled = this.offset === 0;
    this.nextButton.disabled = !page || this.offset + PAGE_SIZE >= total;
  }

  /** The rows, with the player's own highlighted, and the pinned row when theirs is off this page. */
  private renderMine(): void {
    const page = this.currentPage();
    const mine = this.myRank;
    const myId = mine?.kind === 'ranked' ? mine.row.playerId : null;

    this.body.replaceChildren();
    for (const row of page?.rows ?? []) this.appendRow(this.body, row, row.playerId === myId);

    this.pinned.replaceChildren();
    this.jumpButton.disabled = mine?.kind !== 'ranked';
    if (!mine) return;

    if (mine.kind === 'none') {
      node('p', 'lb-muted', this.pinned, NO_RANK[mine.reason]);
      return;
    }

    const first = this.offset + 1;
    const last = this.offset + (page?.rows.length ?? 0);
    if (page && mine.rank >= first && mine.rank <= last) return;

    // AC-LDB-002.5: the player's entry is off this page, so pin it.
    node('p', 'lb-pinned-label', this.pinned, 'Your best');
    const table = node('table', 'lb-table', this.pinned);
    const body = node('tbody', '', table);
    this.appendRow(body, mine.row, true);
  }

  private appendRow(parent: HTMLTableSectionElement, row: BoardRow, self: boolean): void {
    const tr = node('tr', 'lb-row', parent);
    if (self) tr.dataset.self = 'true';
    node('td', 'lb-rank', tr, String(row.rank));
    node('td', 'lb-name', tr, self ? `${row.displayName} (you)` : row.displayName);
    node('td', 'lb-score', tr, row.score.toLocaleString());
    node('td', 'lb-accuracy', tr, formatAccuracy(row.accuracyBp));
    node('td', 'lb-when', tr, formatWhen(row.achievedAt));
    this.renderReplay(node('td', 'lb-replay', tr), row);
  }

  private renderReplay(cell: HTMLElement, row: BoardRow): void {
    // AC-LDB-004.2: say so when there is nothing to race.
    if (!row.hasGhost) {
      node('span', 'lb-muted', cell, 'Replay unavailable');
      return;
    }
    // AC-LDB-004.4: a run from another simulation version cannot be replayed by this build.
    if (row.simVersion !== SIM_VERSION) {
      node('span', 'lb-muted', cell, 'Older version, replay unavailable');
      return;
    }
    // AC-LDB-004.1 and 004.3: offer it, carrying the entry's map, mode and simulation version.
    this.button(cell, 'Race ghost', () => {
      this.options.onGhost({
        runId: row.runId,
        mapId: this.selection.mapId,
        modeId: this.selection.modeId,
        simVersion: row.simVersion,
        playerName: row.displayName,
        score: row.score,
      });
    });
  }
}
