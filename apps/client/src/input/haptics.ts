export interface VibrateNavigator {
  vibrate?: (pattern: number | number[]) => boolean;
}

export class HapticsBridge {
  private enabled: boolean;

  constructor(private readonly target: VibrateNavigator | null = typeof navigator === 'undefined' ? null : navigator) {
    this.enabled = true;
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isSupported(): boolean { return typeof this.target?.vibrate === 'function'; }

  press(): void { this.vibrate(12); }
  release(): void { this.vibrate(6); }

  private vibrate(pattern: number): void {
    if (!this.enabled || !this.target || typeof this.target.vibrate !== 'function') return;
    try { this.target.vibrate(pattern); } catch { /* vibration is best effort */ }
  }
}
