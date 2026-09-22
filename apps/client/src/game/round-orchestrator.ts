/**
 * RoundOrchestrator: the round lifecycle.
 *
 * This was previously a phase string and a handful of setTimeout calls scattered through main.ts.
 * That worked for one path (click, play, end) but every new state added another branch to a growing
 * conditional, and pausing during the countdown already behaved oddly because two timers could be
 * in flight at once.
 *
 * It is now an explicit state machine with a declared transition table. An invalid transition is a
 * no-op instead of a half-applied state, and there is exactly one place to look to answer "what can
 * happen from here".
 *
 * Two deliberate choices:
 *
 * The countdown counts down in simulation ticks rather than milliseconds. A wall-clock countdown
 * drifts from the simulation it is counting into, so on a slow device the round could start before
 * the numbers finished.
 *
 * The orchestrator owns no rendering and no input. It emits state, and the screens and main loop
 * react. That keeps the lifecycle testable and means the React shell in a later work order can
 * replace the screens without touching this file.
 */

import type { RunSummary } from '@rearena/protocol';

export type RoundState =
  /** Title screen. Nothing is running. */
  | 'menu'
  /** Choosing a map and mode. */
  | 'setup'
  /** Simulation is starting and content is loading. */
  | 'loading'
  /** Simulation is live but gameplay input is suppressed; the player can look around. */
  | 'countdown'
  /** Full control. */
  | 'playing'
  /** Frozen. Nothing advances. */
  | 'paused'
  /** Round is over and the summary is shown. */
  | 'results';

export type RoundEvent =
  | 'openSetup'
  | 'backToMenu'
  | 'start'
  | 'loaded'
  | 'countdownComplete'
  | 'pause'
  | 'resume'
  | 'restart'
  | 'quit'
  | 'finish';

/**
 * Legal transitions. Anything not listed cannot happen, which is the point: a pause arriving while
 * loading, or a finish arriving twice, is silently ignored rather than corrupting the state.
 */
const TRANSITIONS: Record<RoundState, Partial<Record<RoundEvent, RoundState>>> = {
  menu: { openSetup: 'setup', start: 'loading' },
  setup: { start: 'loading', backToMenu: 'menu' },
  // A failed load returns to setup; quit covers both cancel and failure.
  loading: { loaded: 'countdown', quit: 'setup' },
  countdown: { countdownComplete: 'playing', pause: 'paused', quit: 'setup', finish: 'results' },
  playing: { pause: 'paused', finish: 'results', quit: 'setup' },
  paused: { resume: 'countdown', restart: 'loading', quit: 'setup', finish: 'results' },
  results: { start: 'loading', openSetup: 'setup', backToMenu: 'menu' },
};

/** Ticks of countdown before a round begins. 90 ticks is 1.5 seconds at 60 Hz. */
export const COUNTDOWN_TICKS = 90;
/** Shorter countdown when resuming from a pause: the player already knows the arena. */
export const RESUME_COUNTDOWN_TICKS = 48;

export interface RoundCallbacks {
  /** Fired on every state change, with the previous state for transition-specific work. */
  onStateChange?(state: RoundState, previous: RoundState): void;
  /** Start the simulation. Resolves once it is running and the first snapshot has arrived. */
  onLoad?(): Promise<void>;
  /** Gameplay is live: acquire pointer lock, start feeding input. */
  onPlay?(): void;
  /** Freeze the simulation and release pointer lock. */
  onPause?(): void;
  /** Unfreeze the simulation. Called at the start of the resume countdown. */
  onResume?(): void;
  /** Tear down the current round without submitting it. */
  onAbandon?(): void;
  onError?(error: unknown): void;
}

export class RoundOrchestrator {
  private state: RoundState = 'menu';
  private countdownRemaining = 0;
  private summary: RunSummary | null = null;
  /** Guards against a second load starting while one is in flight. */
  private loading = false;

  constructor(private readonly callbacks: RoundCallbacks = {}) {}

  current(): RoundState {
    return this.state;
  }

  lastSummary(): RunSummary | null {
    return this.summary;
  }

  /** Seconds remaining in the countdown, for display. */
  countdownSeconds(): number {
    return Math.ceil(this.countdownRemaining / 60);
  }

  /** True when the simulation should be advancing. */
  isSimulationLive(): boolean {
    return this.state === 'countdown' || this.state === 'playing';
  }

  /** True when gameplay input should reach the simulation. Look-only during countdown. */
  isGameplayLive(): boolean {
    return this.state === 'playing';
  }

  /**
   * Apply an event. Returns true when it caused a transition.
   *
   * Everything goes through here, so there is one place where state changes and one place where
   * the side effects for each transition live.
   */
  dispatch(event: RoundEvent): boolean {
    const next = TRANSITIONS[this.state][event];
    if (!next) return false;

    const previous = this.state;
    this.state = next;

    switch (next) {
      case 'loading': {
        // Restarting from a pause abandons the current run before starting a new one.
        if (previous === 'paused' || previous === 'playing' || previous === 'countdown') {
          this.callbacks.onAbandon?.();
        }
        this.summary = null;
        void this.runLoad();
        break;
      }
      case 'countdown': {
        this.countdownRemaining =
          previous === 'paused' ? RESUME_COUNTDOWN_TICKS : COUNTDOWN_TICKS;
        if (previous === 'paused') this.callbacks.onResume?.();
        break;
      }
      case 'playing': {
        this.countdownRemaining = 0;
        this.callbacks.onPlay?.();
        break;
      }
      case 'paused': {
        this.callbacks.onPause?.();
        break;
      }
      case 'setup':
      case 'menu': {
        if (previous !== 'menu' && previous !== 'results' && previous !== 'loading') {
          this.callbacks.onAbandon?.();
        }
        this.countdownRemaining = 0;
        break;
      }
      case 'results': {
        this.countdownRemaining = 0;
        break;
      }
    }

    this.callbacks.onStateChange?.(next, previous);
    return true;
  }

  private async runLoad(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.callbacks.onLoad?.();
      // The player may have quit while loading; only advance if still in that state.
      if (this.state === 'loading') this.dispatch('loaded');
    } catch (error) {
      this.callbacks.onError?.(error);
      if (this.state === 'loading') this.dispatch('quit');
    } finally {
      this.loading = false;
    }
  }

  /**
   * Advance the countdown.
   *
   * Driven by the simulation's tick count rather than wall-clock time, so the numbers on screen and
   * the simulation they are counting into cannot drift apart on a slow device.
   */
  onSimulationTick(tick: number): void {
    if (this.state !== 'countdown') return;
    this.countdownRemaining = Math.max(0, this.countdownRemaining - 1);
    void tick;
    if (this.countdownRemaining === 0) this.dispatch('countdownComplete');
  }

  /** The simulation reported the round is over. */
  finish(summary: RunSummary): void {
    this.summary = summary;
    this.dispatch('finish');
  }

  /** Convenience for the pause key and for losing focus. */
  togglePause(): void {
    if (this.state === 'playing' || this.state === 'countdown') this.dispatch('pause');
    else if (this.state === 'paused') this.dispatch('resume');
  }
}
