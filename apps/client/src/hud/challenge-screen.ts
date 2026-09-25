import '../challenge.css';
import {
  getChallengeBoard,
  getChallengeHistory,
  getCurrentChallenge,
  startChallengeAttempt,
  type ChallengeAttempt,
  type ChallengeBoardRow,
  type ChallengeDescriptor,
  type ChallengeHistoryEntry,
} from '../net/challenge-api.js';

export type ChallengeAvailability = 'available' | 'used' | 'closed' | 'unavailable';

export function formatChallengeCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':');
}

export function deriveChallengeAvailability(
  challenge: Pick<ChallengeDescriptor, 'attempt_used' | 'opens_at' | 'closes_at'>,
  now = Date.now(),
): ChallengeAvailability {
  if (now < Date.parse(challenge.opens_at) || now >= Date.parse(challenge.closes_at)) return 'closed';
  return challenge.attempt_used ? 'used' : 'available';
}

export interface ChallengeStartConfig extends ChallengeAttempt {
  challenge_id: string;
}

export interface ChallengeScreenOptions {
  onStart?(attempt: ChallengeStartConfig): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export class ChallengeScreen {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private readonly start: HTMLButtonElement;
  private readonly countdown: HTMLSpanElement;
  private descriptor: ChallengeDescriptor | null = null;
  private timer = 0;
  private request = 0;
  private disposed = false;
  private readonly options: ChallengeScreenOptions;

  constructor(private readonly parent: HTMLElement, options: ChallengeScreenOptions = {}) {
    this.options = options;
    this.root = element('div', 'challenge-overlay');
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    const panel = element('section', 'challenge-panel');
    const header = element('header', 'challenge-header');
    const title = element('h2', undefined);
    title.textContent = 'Daily Challenge';
    const close = element('button', 'challenge-close');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.close());
    header.append(title, close);
    this.status = element('p', 'challenge-status');
    this.countdown = element('span', 'challenge-countdown');
    this.start = element('button', 'screen-button challenge-start');
    this.start.type = 'button';
    this.start.textContent = 'Start Challenge';
    this.start.addEventListener('click', () => void this.confirmStart());
    this.body = element('div', 'challenge-body');
    panel.append(header, this.status, this.countdown, this.start, this.body);
    this.root.append(panel);
    parent.append(this.root);
  }

  open(): void {
    this.root.hidden = false;
    void this.load();
  }

  close(): void {
    this.root.hidden = true;
  }

  isOpen(): boolean { return !this.root.hidden; }

  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.timer);
    this.root.remove();
  }

  private async load(): Promise<void> {
    const request = ++this.request;
    this.status.textContent = 'Loading today\'s Challenge…';
    this.start.disabled = true;
    this.body.replaceChildren();
    try {
      const descriptor = await getCurrentChallenge();
      const [board, history] = await Promise.all([
        getChallengeBoard(descriptor.challenge_id),
        getChallengeHistory(30),
      ]);
      if (this.disposed || request !== this.request) return;
      this.descriptor = descriptor;
      this.render(descriptor, board, history);
    } catch (error) {
      if (request !== this.request) return;
      this.descriptor = null;
      this.countdown.textContent = '';
      this.status.textContent = error instanceof Error ? error.message : 'Daily Challenge is unavailable.';
      this.start.disabled = true;
      const retry = element('button', 'screen-button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => void this.load());
      this.body.append(retry);
    }
  }

  private render(descriptor: ChallengeDescriptor, board: ChallengeBoardRow[], history: ChallengeHistoryEntry[]): void {
    const availability = deriveChallengeAvailability(descriptor);
    this.status.textContent = availability === 'available'
      ? 'One attempt is available.'
      : availability === 'used' ? 'This attempt is used. No restart is available.' : 'This Challenge Day is closed.';
    this.start.disabled = availability !== 'available';
    this.body.replaceChildren();
    const config = element('div', 'challenge-config');
    config.innerHTML = `<p><strong>Map:</strong> ${descriptor.map_id}</p><p><strong>Mode:</strong> ${descriptor.mode_id}</p><p><strong>Modifiers:</strong> ${Object.keys(descriptor.modifiers).join(', ') || 'None'}</p><p><strong>Window:</strong> ${localTime(descriptor.opens_at)} to ${localTime(descriptor.closes_at)} (local time)</p><p class="challenge-authority">The UTC service clock is authoritative.</p>`;
    const result = element('p', 'challenge-result');
    result.textContent = descriptor.result_score == null ? (descriptor.attempt_used ? 'Result pending verification or forfeited.' : '') : `Verified result: ${descriptor.result_score.toLocaleString()}`;
    const boardSection = element('section', 'challenge-section');
    const boardTitle = element('h3'); boardTitle.textContent = 'Today\'s Challenge Board';
    const boardList = element('ol', 'challenge-board');
    for (const row of board) { const item = element('li'); item.textContent = `#${row.rank} ${row.display_name}: ${row.score.toLocaleString()}`; boardList.append(item); }
    if (!board.length) { const empty = element('p'); empty.textContent = 'No verified results yet.'; boardSection.append(boardTitle, empty); } else boardSection.append(boardTitle, boardList);
    const historySection = element('section', 'challenge-section');
    const historyTitle = element('h3'); historyTitle.textContent = 'History and Streak';
    const historyList = element('ul', 'challenge-history');
    const streak = history[0]?.current_streak ?? 0;
    const streakText = element('p'); streakText.textContent = `Current streak: ${streak} day${streak === 1 ? '' : 's'}`;
    for (const entry of history) { const item = element('li'); item.textContent = `${entry.challenge_date}: ${entry.score.toLocaleString()}`; historyList.append(item); }
    historySection.append(historyTitle, streakText, historyList);
    this.body.append(config, result, boardSection, historySection);
    this.updateCountdown();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.updateCountdown(), 1000);
  }

  private updateCountdown(): void {
    if (!this.descriptor) return;
    const milliseconds = Date.parse(this.descriptor.closes_at) - Date.now();
    this.countdown.textContent = milliseconds > 0 ? `Next UTC cutoff: ${formatChallengeCountdown(milliseconds)}` : 'Challenge closed. Refresh for the next day.';
    if (milliseconds <= 0) this.start.disabled = true;
  }

  private async confirmStart(): Promise<void> {
    if (!this.descriptor || deriveChallengeAvailability(this.descriptor) !== 'available') return;
    if (!window.confirm('Closing this page consumes your attempt. You cannot restart this Challenge. Continue?')) return;
    this.start.disabled = true;
    try {
      const attempt = await startChallengeAttempt(this.descriptor.challenge_id);
      this.descriptor = { ...this.descriptor, attempt_used: true, attempt_started_at: attempt.attempt_started_at };
      this.status.textContent = 'Attempt started. Closing the page consumes it. No restart is available.';
      this.options.onStart?.({ ...attempt, challenge_id: this.descriptor.challenge_id });
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : 'The Challenge attempt could not start.';
      this.start.disabled = true;
    }
  }
}
