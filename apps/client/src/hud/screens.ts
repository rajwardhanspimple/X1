/**
 * Screens: everything the player sees when they are not shooting.
 *
 * Plain DOM, one container per screen, shown and hidden by a dataset attribute on the root. Two
 * reasons over a framework here: a screen change is a single attribute write rather than a render
 * pass, and every button is a real focusable element, which is what keyboard and gamepad navigation
 * need in WO-22 and WO-29.
 *
 * Screens own no game logic. They render the orchestrator's state and report intent back through a
 * single callback, so the React shell in a later work order can replace this file without touching
 * the lifecycle.
 */

import type { RunSummary } from '@rearena/protocol';
import type { RoundState } from '../game/round-orchestrator.js';

/** Every action a screen can ask for. The orchestrator decides whether it is legal. */
export type ScreenAction =
  | 'openSetup'
  | 'backToMenu'
  | 'start'
  | 'resume'
  | 'restart'
  | 'quit'
  | 'toggleMute'
  | 'selectMap'
  | 'selectMode';

export interface MapOption {
  id: string;
  name: string;
  detail: string;
}

export interface ModeOption {
  id: string;
  name: string;
  detail: string;
}

export interface ScreenCallbacks {
  onAction(action: ScreenAction, value?: string): void;
}

const CONTROLS: Array<[string, string]> = [
  ['Move', 'W A S D'],
  ['Sprint', 'Shift'],
  ['Crouch', 'C'],
  ['Jump', 'Space'],
  ['Fire', 'Left mouse'],
  ['Aim', 'Right mouse'],
  ['Reload', 'R'],
  ['Swap weapon', 'Q'],
  ['Pause', 'Escape'],
  ['Mute', 'M'],
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

function button(label: string, action: ScreenAction, parent: HTMLElement, primary = false): HTMLButtonElement {
  const node = el('button', primary ? 'screen-button screen-button-primary' : 'screen-button', parent);
  node.type = 'button';
  node.textContent = label;
  node.dataset.action = action;
  return node;
}

export class Screens {
  private readonly root: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly setup: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly countdownNumber: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly results: HTMLElement;

  private readonly mapList: HTMLElement;
  private readonly modeList: HTMLElement;
  private readonly resultRows: HTMLElement;
  private readonly resultMedals: HTMLElement;
  private readonly resultVerify: HTMLElement;
  private readonly muteButton: HTMLButtonElement;

  private selectedMap = '';
  private selectedMode = '';

  constructor(
    container: HTMLElement,
    private readonly maps: readonly MapOption[],
    private readonly modes: readonly ModeOption[],
    private readonly callbacks: ScreenCallbacks,
  ) {
    this.root = el('div', 'screens', container);
    this.selectedMap = maps[0]?.id ?? '';
    this.selectedMode = modes[0]?.id ?? '';

    // --- Main menu ---------------------------------------------------------------------------
    this.menu = el('section', 'screen screen-menu', this.root);
    const title = el('h1', 'screen-title', this.menu);
    title.textContent = 'RE:ARENA';
    const tagline = el('p', 'screen-tagline', this.menu);
    tagline.textContent = 'Three minutes. Hold the arena.';

    const menuActions = el('div', 'screen-actions', this.menu);
    button('Play', 'start', menuActions, true);
    button('Choose arena', 'openSetup', menuActions);

    const controls = el('div', 'screen-controls', this.menu);
    const controlsTitle = el('h2', 'screen-subtitle', controls);
    controlsTitle.textContent = 'Controls';
    const controlsGrid = el('dl', 'controls-grid', controls);
    for (const [action, key] of CONTROLS) {
      const term = el('dt', 'controls-term', controlsGrid);
      term.textContent = action;
      const def = el('dd', 'controls-key', controlsGrid);
      def.textContent = key;
    }

    // --- Match setup -------------------------------------------------------------------------
    this.setup = el('section', 'screen screen-setup', this.root);
    const setupTitle = el('h1', 'screen-title-small', this.setup);
    setupTitle.textContent = 'Match setup';

    const mapBlock = el('div', 'setup-block', this.setup);
    const mapLabel = el('h2', 'screen-subtitle', mapBlock);
    mapLabel.textContent = 'Arena';
    this.mapList = el('div', 'option-list', mapBlock);

    const modeBlock = el('div', 'setup-block', this.setup);
    const modeLabel = el('h2', 'screen-subtitle', modeBlock);
    modeLabel.textContent = 'Mode';
    this.modeList = el('div', 'option-list', modeBlock);

    const setupActions = el('div', 'screen-actions', this.setup);
    button('Start round', 'start', setupActions, true);
    button('Back', 'backToMenu', setupActions);

    // --- Loading -----------------------------------------------------------------------------
    this.loading = el('section', 'screen screen-loading', this.root);
    const loadingText = el('p', 'screen-loading-text', this.loading);
    loadingText.textContent = 'Preparing arena';

    // --- Countdown ---------------------------------------------------------------------------
    // Not a full screen: it sits over the live view so the player can look around while it runs.
    this.countdown = el('section', 'screen screen-countdown', this.root);
    this.countdownNumber = el('div', 'countdown-number', this.countdown);
    const countdownHint = el('p', 'countdown-hint', this.countdown);
    countdownHint.textContent = 'Look around';

    // --- Pause -------------------------------------------------------------------------------
    this.pause = el('section', 'screen screen-pause', this.root);
    const pauseTitle = el('h1', 'screen-title-small', this.pause);
    pauseTitle.textContent = 'Paused';
    const pauseActions = el('div', 'screen-actions', this.pause);
    button('Resume', 'resume', pauseActions, true);
    button('Restart round', 'restart', pauseActions);
    this.muteButton = button('Mute audio', 'toggleMute', pauseActions);
    button('Quit to setup', 'quit', pauseActions);

    // --- Results -----------------------------------------------------------------------------
    this.results = el('section', 'screen screen-results', this.root);
    const resultsTitle = el('h1', 'screen-title-small', this.results);
    resultsTitle.textContent = 'Round complete';
    this.resultRows = el('dl', 'result-rows', this.results);
    this.resultMedals = el('div', 'result-medals', this.results);
    this.resultVerify = el('p', 'result-verify', this.results);
    const resultActions = el('div', 'screen-actions', this.results);
    button('Play again', 'start', resultActions, true);
    button('Change arena', 'openSetup', resultActions);
    button('Main menu', 'backToMenu', resultActions);

    this.renderOptions();

    /*
     * One delegated listener rather than one per button. Buttons are rebuilt when the option lists
     * change, and per-button listeners would leak on every rebuild.
     */
    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
      if (!target) return;
      event.stopPropagation();
      const action = target.dataset.action as ScreenAction | undefined;
      if (!action) return;
      this.callbacks.onAction(action, target.dataset.value);
    });
  }

  private renderOptions(): void {
    this.mapList.replaceChildren();
    for (const map of this.maps) {
      const option = el('button', 'option', this.mapList);
      option.type = 'button';
      option.dataset.action = 'selectMap';
      option.dataset.value = map.id;
      option.dataset.selected = map.id === this.selectedMap ? 'true' : 'false';
      const name = el('span', 'option-name', option);
      name.textContent = map.name;
      const detail = el('span', 'option-detail', option);
      detail.textContent = map.detail;
    }

    this.modeList.replaceChildren();
    for (const mode of this.modes) {
      const option = el('button', 'option', this.modeList);
      option.type = 'button';
      option.dataset.action = 'selectMode';
      option.dataset.value = mode.id;
      option.dataset.selected = mode.id === this.selectedMode ? 'true' : 'false';
      const name = el('span', 'option-name', option);
      name.textContent = mode.name;
      const detail = el('span', 'option-detail', option);
      detail.textContent = mode.detail;
    }
  }

  setSelection(mapId: string, modeId: string): void {
    this.selectedMap = mapId;
    this.selectedMode = modeId;
    this.renderOptions();
  }

  selection(): { mapId: string; modeId: string } {
    return { mapId: this.selectedMap, modeId: this.selectedMode };
  }

  setMuted(muted: boolean): void {
    this.muteButton.textContent = muted ? 'Unmute audio' : 'Mute audio';
  }

  /** Show the screen for a state and hide the rest. */
  show(state: RoundState): void {
    this.menu.dataset.visible = String(state === 'menu');
    this.setup.dataset.visible = String(state === 'setup');
    this.loading.dataset.visible = String(state === 'loading');
    this.countdown.dataset.visible = String(state === 'countdown');
    this.pause.dataset.visible = String(state === 'paused');
    this.results.dataset.visible = String(state === 'results');

    /*
     * The container only accepts pointer events when a screen with buttons is up. During play and
     * countdown it must not, or it would swallow the clicks that fire the weapon.
     */
    const interactive =
      state === 'menu' || state === 'setup' || state === 'paused' || state === 'results';
    this.root.dataset.interactive = String(interactive);

    // Move focus to the primary button so keyboard and gamepad users have a starting point.
    if (interactive) {
      const screen =
        state === 'menu'
          ? this.menu
          : state === 'setup'
            ? this.setup
            : state === 'paused'
              ? this.pause
              : this.results;
      screen.querySelector<HTMLButtonElement>('.screen-button-primary')?.focus();
    }
  }

  setCountdown(seconds: number): void {
    this.countdownNumber.textContent = seconds > 0 ? String(seconds) : 'Go';
  }

  /** Fill the results screen. The verification line is updated separately by WO-40. */
  setResults(summary: RunSummary): void {
    this.resultRows.replaceChildren();
    const rows: Array<[string, string]> = [
      ['Score', summary.score.toLocaleString()],
      ['Kills', String(summary.kills)],
      ['Deaths', String(summary.deaths)],
      ['Accuracy', `${(summary.accuracyBp / 100).toFixed(1)}%`],
      ['Shots fired', String(summary.shotsFired)],
      ['Duration', `${Math.round(summary.durationTicks / 60)}s`],
    ];
    for (const [label, value] of rows) {
      const term = el('dt', 'result-term', this.resultRows);
      term.textContent = label;
      const def = el('dd', 'result-value', this.resultRows);
      def.textContent = value;
    }

    this.resultMedals.replaceChildren();
    if (summary.medals.length > 0) {
      for (const medal of summary.medals) {
        const chip = el('span', 'result-medal', this.resultMedals);
        chip.textContent = medal;
      }
    } else {
      const none = el('span', 'result-medal-none', this.resultMedals);
      none.textContent = 'No medals this round';
    }

    // Submission lands in WO-40; until then the result is explicitly local.
    this.setVerification('Result saved locally. Leaderboard submission is not built yet.');
  }

  setVerification(text: string): void {
    this.resultVerify.textContent = text;
  }

  /** Shown when something fails, in place of the loading text. */
  setError(message: string): void {
    const text = this.loading.querySelector('.screen-loading-text');
    if (text) text.textContent = message;
  }

  dispose(): void {
    this.root.remove();
  }
}
