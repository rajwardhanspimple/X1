export interface OrientationLike {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}

type OrientationPermission = 'granted' | 'denied' | 'default';
type OrientationWindow = Window & {
  DeviceOrientationEvent?: typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<OrientationPermission>;
  };
};

export class GyroAimProvider {
  private enabled = false;
  private last: OrientationLike | null = null;
  private readonly orientationWindow: OrientationWindow | null =
    typeof window === 'undefined' ? null : (window as OrientationWindow);

  constructor(
    private readonly onLook: (yawTurns: number, pitchTurns: number) => void,
    private readonly explain: (message: string) => void = () => {},
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async enable(): Promise<boolean> {
    const permission = await this.requestPermission();
    if (permission !== 'granted') {
      this.enabled = false;
      this.last = null;
      this.explain(
        'Gyroscope access was denied. Enable motion access in your device settings, then try again.',
      );
      return false;
    }
    if (!this.orientationWindow) return false;
    this.enabled = true;
    this.last = null;
    this.orientationWindow.addEventListener('deviceorientation', this.handle);
    return true;
  }

  disable(): void {
    this.enabled = false;
    this.last = null;
    this.orientationWindow?.removeEventListener('deviceorientation', this.handle);
  }

  dispose(): void {
    this.disable();
  }

  private async requestPermission(): Promise<OrientationPermission> {
    const eventType = this.orientationWindow?.DeviceOrientationEvent;
    if (!eventType?.requestPermission) {
      return this.orientationWindow ? 'granted' : 'denied';
    }
    try {
      return await eventType.requestPermission();
    } catch {
      return 'denied';
    }
  }

  private readonly handle = (event: Event): void => {
    if (!this.enabled) return;
    const next = event as DeviceOrientationEvent;
    const current: OrientationLike = {
      alpha: next.alpha,
      beta: next.beta,
      gamma: next.gamma,
    };
    if (
      this.last &&
      current.alpha !== null &&
      this.last.alpha !== null &&
      current.beta !== null &&
      this.last.beta !== null
    ) {
      const yaw = wrapDegrees(current.alpha - this.last.alpha) / 360;
      const pitch = (current.beta - this.last.beta) / 360;
      this.onLook(clamp(yaw, -0.05, 0.05), clamp(pitch, -0.05, 0.05));
    }
    this.last = current;
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const wrapDegrees = (value: number): number => ((value + 540) % 360) - 180;
