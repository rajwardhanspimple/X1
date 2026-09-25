/**
 * Screens: everything the player sees when they are not shooting.
 *
 * Plain DOM, one container per screen, shown and hidden by a dataset attribute on the root. Two
 * reasons over a framework here: a screen change is a single attribute write rather than a render
 * pass, and every button is a real focusable element, which is what keyboard and gamepad navigation
 * need.
 *
 * Screens own no game logic. They render state and report intent through one callback, so the React
 * shell in a later work order can replace this file without touching the lifecycle.
 */

import type { RunSummary } from '@rearena/protocol';
import type { RoundState } from '../game/round-orchestrator.js';
import {
  TIER_ORDER,
  TIERS,
  type QualitySettings,
  type QualityTierName,
} from '../render/quality.js';

/** Every action a screen can ask for. The orchestrator decides whether it is legal. */
export type ScreenAction =
  | 'openSetup'
  | 'openSettings'
  | 'backToMenu'
  | 'start'
  | 'resume'
  | 'restart'
  | 'quit'
  | 'toggleMute'
  | 'selectMap'
  | 'selectMode'
  | 'selectTier'
  | 'toggleDynamicResolution'
  | 'selectFrameCap'
  | 'toggleFrameStats';

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

/**
 * The Result Screen's verification line (WO-40).
 *
 * The tone picks the styling; the text always states the outcome on its own, so colour is never the only signal.
 * `onRetry` adds a Retry button, used when a submission failed and the run is still only on this device.
 */
export interface VerificationView {
  text: string;
  tone: 'neutral' | 'pending' | 'good' | 'bad';
  onRetry?: () => void;
}

const CONTROLS: Array<[string, string]> = [
  ['Move', 'W A S D'],
  ['Sprint', 'Shift'],
  ['Crouch', 'C'],
  // Slide has no key of its own: it is crouch while sprinting. See withSlide in input/bindings.ts.
  ['Slide', 'C while sprinting'],
  ['Jump', 'Space'],
  ['Fire', 'Left mouse'],
  ['Aim', 'Right mouse'],
  ['Reload', 'R'],
  ['Swap weapon', 'Q'],
  ['Pause', 'Escape'],
  ['Mute', 'M'],
];

/** Frame rate caps offered. 0 means uncapped. */
const FRAME_CAPS: Array<{ value: number; label: string }> = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 120, label: '120' },
  { value: 0, label: 'Uncapped' },
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

function button(
  label: string,
  action: ScreenAction,
  parent: HTMLElement,
  primary = false,
): HTMLButtonElement {
  const node = el(
    'button',
    primary ? 'screen-button screen-button-primary' : 'screen-button',
    parent,
  );
  node.type = 'button';
  node.textContent = label;
  node.dataset.action = action;
  return node;
}

export class Screens {
  private readonly root: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly setup: HTMLElement;
  private readonly settings: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly countdownNumber: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly results: HTMLElement;

  private readonly mapList: HTMLElement;
  private readonly modeList: HTMLElement;
  private readonly tierList: HTMLElement;
  private readonly capList: HTMLElement;
  private readonly dynamicToggle: HTMLButtonElement;
  private readonly statsToggle: HTMLButtonElement;
  private readonly lowPowerNote: HTMLElement;
  private readonly resultRows: HTMLElement;
  private readonly resultMedals: HTMLElement;
  private readonly resultVerify: HTMLElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly notice: HTMLElement;

  private selectedMap = '';
  private selectedMode = '';
  /** Set when the screen is opened from the pause menu, so Back returns there. */
  private settingsOrigin: RoundState = 'menu';
  private quality: QualitySettings | null = null;
  private probedTier: QualityTierName | null = null;

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
    button('Settings', 'openSettings', menuActions);

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

    // --- Settings ----------------------------------------------------------------------------
    this.settings = el('section', 'screen screen-settings', this.root);
    const settingsTitle = el('h1', 'screen-title-small', this.settings);
    settingsTitle.textContent = 'Settings';

    const tierBlock = el('div', 'setup-block', this.settings);
    const tierLabel = el('h2', 'screen-subtitle', tierBlock);
    tierLabel.textContent = 'Quality';
    this.tierList = el('div', 'option-list', tierBlock);

    const perfBlock = el('div', 'setup-block', this.settings);
    const perfLabel = el('h2', 'screen-subtitle', perfBlock);
    perfLabel.textContent = 'Performance';
    const perfRow = el('div', 'settings-row', perfBlock);
    this.dynamicToggle = button('Dynamic resolution: on', 'toggleDynamicResolution', perfRow);
    this.statsToggle = button('Frame stats: off', 'toggleFrameStats', perfRow);

    const capLabel = el('h2', 'screen-subtitle', perfBlock);
    capLabel.textContent = 'Frame rate cap';
    this.capList = el('div', 'settings-row', perfBlock);

    this.lowPowerNote = el('p', 'settings-note', this.settings);

    const settingsActions = el('div', 'screen-actions', this.settings);
    button('Back', 'backToMenu', settingsActions, true);

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
    button('Settings', 'openSettings', pauseActions);
    this.muteButton = button('Mute audio', 'toggleMute', pauseActions);
    button('Quit to setup', 'quit', pauseActions);

    // --- Results -----------------------------------------------------------------------------
    this.results = el('section', 'screen screen-results', this.root);
    const resultsTitle = el('h1', 'screen-title-small', this.results);
    resultsTitle.textContent = 'Round complete';
    this.resultRows = el('dl', 'result-rows', this.results);
    this.resultMedals = el('div', 'result-medals', this.results);
    this.resultVerify = el('div', 'result-verify', this.results);
    // A live region, so the verdict is announced when it arrives rather than only when focus lands on it.
    this.resultVerify.setAttribute('role', 'status');
    const resultActions = el('div', 'screen-actions', this.results);
    button('Play again', 'start', resultActions, true);
    button('Change arena', 'openSetup', resultActions);
    button('Main menu', 'backToMenu', resultActions);

    /*
     * A notice line for things the player must be told but did not ask for: a forced quality drop
     * under memory pressure, or a recovery message. It sits outside the screens so it is visible
     * whichever one is up.
     */
    this.notice = el('div', 'screen-notice', container);
    this.notice.dataset.visible = 'false';

    this.renderOptions();
    this.renderFrameCaps();

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

  private renderFrameCaps(): void {
    this.capList.replaceChildren();
    for (const cap of FRAME_CAPS) {
      const node = el('button', 'screen-button screen-button-compact', this.capList);
      node.type = 'button';
      node.dataset.action = 'selectFrameCap';
      node.dataset.value = String(cap.value);
      node.dataset.selected = this.quality?.frameRateCap === cap.value ? 'true' : 'false';
      node.textContent = cap.label;
    }
  }

  /**
   * Render the quality block.
   *
   * The auto-detected tier is marked explicitly. A player who opens settings and sees "Medium" with
   * no explanation assumes the game ignored their hardware; saying it was measured is the difference
   * between a considered default and an apparent oversight (AC-PRF-001.3).
   */
  setQuality(settings: QualitySettings, probed: QualityTierName | null): void {
    this.quality = settings;
    this.probedTier = probed;

    this.tierList.replaceChildren();
    for (const name of TIER_ORDER) {
      const tier = TIERS[name];
      const option = el('button', 'option', this.tierList);
      option.type = 'button';
      option.dataset.action = 'selectTier';
      option.dataset.value = name;
      option.dataset.selected = settings.tier === name ? 'true' : 'false';
      const label = el('span', 'option-name', option);
      label.textContent = name === this.probedTier ? `${tier.label} (detected)` : tier.label;
      const detail = el('span', 'option-detail', option);
      detail.textContent = this.describeTier(name);
    }

    this.dynamicToggle.textContent = `Dynamic resolution: ${settings.dynamicResolution ? 'on' : 'off'}`;
    this.statsToggle.textContent = `Frame stats: ${settings.showFrameStats ? 'on' : 'off'}`;
    this.renderFrameCaps();

    // Low-power mode is detected, not chosen, so it is reported rather than offered as a toggle.
    if (settings.lowPowerMode) {
      this.lowPowerNote.textContent =
        'Low-power mode is active for this session. Visual detail is reduced to save battery.';
      this.lowPowerNote.dataset.visible = 'true';
    } else {
      this.lowPowerNote.dataset.visible = 'false';
    }
  }

  private describeTier(name: QualityTierName): string {
    const tier = TIERS[name];
    const shadows = tier.shadowMapSize === 0 ? 'no shadows' : `${tier.shadowMapSize}px shadows`;
    const scale = `${Math.round(tier.resolutionScale * 100)}% resolution`;
    const extras = tier.casingsEnabled ? 'full effects' : 'reduced effects';
    return `${scale}, ${shadows}, ${extras}`;
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

  /** Remember where settings was opened from, so Back returns there. */
  noteSettingsOrigin(state: RoundState): void {
    this.settingsOrigin = state;
  }

  settingsReturnState(): RoundState {
    return this.settingsOrigin;
  }

  /** Show the screen for a state and hide the rest. */
  show(state: RoundState): void {
    this.menu.dataset.visible = String(state === 'menu');
    this.setup.dataset.visible = String(state === 'setup');
    this.settings.dataset.visible = String(state === 'settings');
    this.loading.dataset.visible = String(state === 'loading');
    this.countdown.dataset.visible = String(state === 'countdown');
    this.pause.dataset.visible = String(state === 'paused');
    this.results.dataset.visible = String(state === 'results');

    /*
     * The container only accepts pointer events when a screen with buttons is up. During play and
     * countdown it must not, or it would swallow the clicks that fire the weapon.
     */
    const interactive =
      state === 'menu' ||
      state === 'setup' ||
      state === 'settings' ||
      state === 'paused' ||
      state === 'results';
    this.root.dataset.interactive = String(interactive);

    // Move focus to the primary button so keyboard and gamepad users have a starting point.
    if (interactive) {
      const screen =
        state === 'menu'
          ? this.menu
          : state === 'setup'
            ? this.setup
            : state === 'settings'
              ? this.settings
              : state === 'paused'
                ? this.pause
                : this.results;
      screen.querySelector<HTMLButtonElement>('.screen-button-primary')?.focus();
    }
  }

  setCountdown(seconds: number): void {
    this.countdownNumber.textContent = seconds > 0 ? String(seconds) : 'Go';
  }

  /** Fill the results screen. The verification line is driven separately, by the verification mount. */
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

    // Cleared rather than filled: the verification mount writes the line once it knows what to say.
    this.resultVerify.replaceChildren();
    delete this.resultVerify.dataset.tone;
  }

  /** Plain status text with no tone and no retry. Kept for callers that only have a sentence to show. */
  setVerification(text: string): void {
    this.setVerificationView({ text, tone: 'neutral' });
  }

  /** Render the verification line, with a Retry button when the view offers one. */
  setVerificationView(view: VerificationView): void {
    this.resultVerify.replaceChildren();
    this.resultVerify.dataset.tone = view.tone;
    const text = el('span', 'result-verify-text', this.resultVerify);
    text.textContent = view.text;

    const onRetry = view.onRetry;
    if (onRetry) {
      const retry = el('button', 'screen-button screen-button-compact', this.resultVerify);
      retry.type = 'button';
      retry.textContent = 'Retry';
      // No data-action, so the delegated screen listener ignores it and only this handler runs.
      retry.addEventListener('click', (event) => {
        event.stopPropagation();
        onRetry();
      });
    }
  }

  /** Shown when something fails, in place of the loading text. */
  setError(message: string): void {
    const text = this.loading.querySelector('.screen-loading-text');
    if (text) text.textContent = message;
  }

  /**
   * Tell the player something they did not ask about: a forced quality drop, or a recovery message.
   * Auto-dismisses unless it is persistent, because a notice that never leaves becomes furniture.
   */
  showNotice(message: string, persistent = false): void {
    this.notice.textContent = message;
    this.notice.dataset.visible = 'true';
    if (!persistent) {
      window.setTimeout(() => {
        this.notice.dataset.visible = 'false';
      }, 5200);
    }
  }

  dispose(): void {
    this.root.remove();
    this.notice.remove();
  }
}
