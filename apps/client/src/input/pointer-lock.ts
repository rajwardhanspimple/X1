/**
 * PointerLockManager.
 *
 * Pointer lock is the difference between a shooter and a page with a canvas on it, and browsers
 * only grant it from a user gesture. This wraps the lifecycle so the rest of the client does not
 * have to reason about it: request when a round starts, release on pause, re-acquire on resume,
 * and report a denial so the UI can tell the player what happened instead of leaving them unable
 * to aim with no explanation.
 *
 * Chrome enforces a short cooldown after an unlock before another request succeeds, so a failed
 * re-lock is expected and is surfaced as `blocked` rather than treated as an error.
 */

export type PointerLockState = 'locked' | 'unlocked' | 'denied' | 'blocked' | 'unsupported';

export interface PointerLockCallbacks {
  onChange?(state: PointerLockState): void;
}

export class PointerLockManager {
  private state: PointerLockState = 'unlocked';
  private wanted = false;
  private lastRequestAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detach: Array<() => void> = [];

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerLockCallbacks = {},
  ) {
    if (!('requestPointerLock' in element)) {
      this.set('unsupported');
      return;
    }

    const onChange = () => {
      const locked = document.pointerLockElement === this.element;
      if (locked) {
        this.set('locked');
        return;
      }
      // Lost the lock. If it is still wanted, the player pressed Escape, which the browser
      // reserves; treat it as an unlock the game should react to rather than fight.
      this.set('unlocked');
    };
    const onError = () => {
      // Distinguish a cooldown rejection from an outright refusal. Within two seconds of the last
      // request the browser is almost certainly rate limiting, not denying.
      const soon = performance.now() - this.lastRequestAt < 2000;
      this.set(soon ? 'blocked' : 'denied');
      if (this.wanted && soon) this.scheduleRetry();
    };

    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('pointerlockerror', onError);
    this.detach.push(() => document.removeEventListener('pointerlockchange', onChange));
    this.detach.push(() => document.removeEventListener('pointerlockerror', onError));
  }

  private set(state: PointerLockState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onChange?.(state);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) void this.request();
    }, 1500);
  }

  /** Must be called from a user gesture handler (click, keydown) or the browser refuses. */
  async request(): Promise<PointerLockState> {
    if (this.state === 'unsupported') return this.state;
    this.wanted = true;
    if (document.pointerLockElement === this.element) {
      this.set('locked');
      return this.state;
    }
    this.lastRequestAt = performance.now();
    try {
      // Newer browsers return a promise; older ones return undefined. Both are handled.
      await Promise.resolve(this.element.requestPointerLock());
    } catch {
      // pointerlockerror fires separately and sets the state; nothing to add here.
    }
    return this.state;
  }

  release(): void {
    this.wanted = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  isLocked(): boolean {
    return this.state === 'locked';
  }

  current(): PointerLockState {
    return this.state;
  }

  dispose(): void {
    this.release();
    for (const off of this.detach) off();
    this.detach.length = 0;
  }
}
