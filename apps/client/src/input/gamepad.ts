/**
 * GamepadAdapter.
 *
 * The Gamepad API exposes no events for button or axis state, only a snapshot array, so the pad has
 * to be polled. Polling happens once per simulation tick from the router's drain rather than once
 * per animation frame: on a 144 Hz display a per-frame poll samples the stick 144 times to produce
 * 60 frames of input, and the surplus is discarded anyway.
 *
 * Sensitivity is applied here, before the router, exactly as it is for mouse and touch, so a RunLog
 * records the player's intent rather than their hardware and stays device independent.
 */

import { Buttons, type ButtonMask } from '@rearena/protocol';

/** Standard mapping indices. Named so the bindings read as actions rather than numbers. */
const PAD = {
  faceDown: 0, // A / Cross
  faceRight: 1, // B / Circle
  faceLeft: 2, // X / Square
  faceUp: 3, // Y / Triangle
  leftBumper: 4,
  rightBumper: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  select: 8,
  start: 9,
  leftStick: 10,
  rightStick: 11,
} as const;

/** Which glyph set to show in hints. Detected from the controller id string. */
export type ControllerFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic';

export interface GamepadSettings {
  /** Turns of yaw per second at full stick deflection. */
  lookSensitivity: number;
  /** Multiplier applied while aiming. */
  adsSensitivityScale: number;
  invertY: boolean;
  /** Radial dead zone as a fraction of full deflection. */
  deadZone: number;
  /**
   * Response curve exponent for the look stick. Above 1 gives fine control near centre and fast
   * turns at full push, which is what makes a stick usable for aiming.
   */
  lookCurve: number;
  /** Aim assist is on by default for a pad and off for every other device. */
  aimAssist: boolean;
  vibration: boolean;
}

export const DEFAULT_GAMEPAD_SETTINGS: GamepadSettings = {
  lookSensitivity: 0.55,
  adsSensitivityScale: 0.6,
  invertY: false,
  deadZone: 0.18,
  lookCurve: 2.2,
  aimAssist: true,
  vibration: true,
};

export interface GamepadInput {
  moveX: number;
  moveY: number;
  lookYawTurns: number;
  lookPitchTurns: number;
  buttons: ButtonMask;
  pausePressed: boolean;
  /** True when any stick or button was active, so the router can note the live scheme. */
  active: boolean;
}

export interface GamepadCallbacks {
  onConnect?(family: ControllerFamily, id: string): void;
  /** A disconnect during play should pause the round rather than freeze the player. */
  onDisconnect?(): void;
}

function detectFamily(id: string): ControllerFamily {
  const lower = id.toLowerCase();
  if (lower.includes('xbox') || lower.includes('xinput')) return 'xbox';
  if (lower.includes('dualsense') || lower.includes('dualshock') || lower.includes('playstation')) {
    return 'playstation';
  }
  if (lower.includes('nintendo') || lower.includes('joy-con') || lower.includes('pro controller')) {
    return 'nintendo';
  }
  return 'generic';
}

/** Action button labels per family, for HUD hints. */
export const GLYPHS: Record<ControllerFamily, Record<string, string>> = {
  xbox: { fire: 'RT', aim: 'LT', reload: 'X', jump: 'A', crouch: 'B', swap: 'Y', pause: 'Menu' },
  playstation: {
    fire: 'R2',
    aim: 'L2',
    reload: 'Square',
    jump: 'Cross',
    crouch: 'Circle',
    swap: 'Triangle',
    pause: 'Options',
  },
  nintendo: { fire: 'ZR', aim: 'ZL', reload: 'Y', jump: 'B', crouch: 'A', swap: 'X', pause: '+' },
  generic: {
    fire: 'R2',
    aim: 'L2',
    reload: 'B3',
    jump: 'B1',
    crouch: 'B2',
    swap: 'B4',
    pause: 'Start',
  },
};

/**
 * Radial dead zone.
 *
 * Applied to the vector, not to each axis. A per-axis dead zone leaves a square hole at the centre,
 * so a slow diagonal push reads as purely horizontal until it clears the threshold on both axes. The
 * radial form rescales the remaining range, so slow movement stays proportional in every direction.
 */
function applyDeadZone(x: number, y: number, deadZone: number): { x: number; y: number } {
  const magnitude = Math.sqrt(x * x + y * y);
  if (magnitude < deadZone) return { x: 0, y: 0 };
  // Rescale so the first usable value is just above zero rather than jumping to the dead zone size.
  const scaled = Math.min(1, (magnitude - deadZone) / (1 - deadZone));
  return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled };
}

export class GamepadAdapter {
  private settings: GamepadSettings = DEFAULT_GAMEPAD_SETTINGS;
  private index: number | null = null;
  private family: ControllerFamily = 'generic';
  private previousButtons: boolean[] = [];
  private readonly detach: Array<() => void> = [];

  constructor(private readonly callbacks: GamepadCallbacks = {}) {
    const onConnect = (event: GamepadEvent) => {
      // First pad wins. Multi-pad local play is out of scope.
      if (this.index !== null) return;
      this.index = event.gamepad.index;
      this.family = detectFamily(event.gamepad.id);
      this.previousButtons = [];
      this.callbacks.onConnect?.(this.family, event.gamepad.id);
    };

    const onDisconnect = (event: GamepadEvent) => {
      if (event.gamepad.index !== this.index) return;
      this.index = null;
      this.previousButtons = [];
      this.callbacks.onDisconnect?.();
    };

    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    this.detach.push(
      () => window.removeEventListener('gamepadconnected', onConnect),
      () => window.removeEventListener('gamepaddisconnected', onDisconnect),
    );

    // A pad connected before the page loaded fires no event, so adopt any already present.
    this.adoptExisting();
  }

  private adoptExisting(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      this.index = pad.index;
      this.family = detectFamily(pad.id);
      this.callbacks.onConnect?.(this.family, pad.id);
      return;
    }
  }

  setSettings(settings: GamepadSettings): void {
    this.settings = settings;
  }

  getSettings(): GamepadSettings {
    return this.settings;
  }

  isConnected(): boolean {
    return this.index !== null;
  }

  controllerFamily(): ControllerFamily {
    return this.family;
  }

  /** Current pad snapshot, or null. Snapshots are not live objects in most browsers. */
  private pad(): Gamepad | null {
    if (this.index === null) return null;
    const pads = navigator.getGamepads?.() ?? [];
    return pads[this.index] ?? null;
  }

  /** True on the tick a button went from up to down, for actions that must not repeat. */
  private pressed(pad: Gamepad, button: number): boolean {
    const now = pad.buttons[button]?.pressed ?? false;
    const before = this.previousButtons[button] ?? false;
    return now && !before;
  }

  private held(pad: Gamepad, button: number): boolean {
    return pad.buttons[button]?.pressed ?? false;
  }

  clearHeld(): void {
    this.previousButtons = [];
  }

  /**
   * Read the pad for this tick.
   *
   * dtSeconds scales the look, because a stick reports a position rather than a delta: holding it
   * halfway should turn at a constant rate regardless of tick length.
   */
  drain(dtSeconds: number): GamepadInput {
    const idle: GamepadInput = {
      moveX: 0,
      moveY: 0,
      lookYawTurns: 0,
      lookPitchTurns: 0,
      buttons: Buttons.None,
      pausePressed: false,
      active: false,
    };

    const pad = this.pad();
    if (!pad) return idle;

    const move = applyDeadZone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), this.settings.deadZone);
    const lookRaw = applyDeadZone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.settings.deadZone);

    const aiming = this.held(pad, PAD.leftTrigger) || this.held(pad, PAD.leftBumper);

    /*
     * Response curve: raising the magnitude to a power keeps small movements fine for tracking and
     * leaves full deflection fast for turning. A linear stick is the main reason pad aiming feels
     * either sluggish or twitchy with no middle ground.
     */
    const curve = (value: number): number =>
      Math.sign(value) * Math.pow(Math.abs(value), this.settings.lookCurve);

    const scale =
      this.settings.lookSensitivity * dtSeconds * (aiming ? this.settings.adsSensitivityScale : 1);
    const lookYawTurns = curve(lookRaw.x) * scale;
    const lookPitchTurns = curve(lookRaw.y) * scale * (this.settings.invertY ? 1 : -1);

    let buttons: ButtonMask = Buttons.None;
    if (this.held(pad, PAD.rightTrigger) || this.held(pad, PAD.rightBumper))
      buttons |= Buttons.Fire;
    if (aiming) buttons |= Buttons.Aim;
    if (this.held(pad, PAD.faceLeft)) buttons |= Buttons.Reload;
    if (this.held(pad, PAD.faceDown)) buttons |= Buttons.Jump;
    if (this.held(pad, PAD.faceRight)) buttons |= Buttons.Crouch;
    if (this.held(pad, PAD.faceUp)) buttons |= Buttons.Swap;
    // Sprint on the left stick click, which is where every console shooter puts it.
    if (this.held(pad, PAD.leftStick)) buttons |= Buttons.Sprint;

    // Pause is edge-triggered: holding Start must not toggle the pause menu every tick.
    const pausePressed = this.pressed(pad, PAD.start) || this.pressed(pad, PAD.select);

    // Snapshot button state for the next tick's edge detection.
    this.previousButtons = pad.buttons.map((b) => b.pressed);

    const active =
      move.x !== 0 ||
      move.y !== 0 ||
      lookRaw.x !== 0 ||
      lookRaw.y !== 0 ||
      buttons !== Buttons.None;

    return {
      moveX: move.x,
      moveY: move.y,
      lookYawTurns,
      lookPitchTurns,
      buttons,
      pausePressed,
      active,
    };
  }

  /** Rumble, where the browser supports it. Purely cosmetic and always optional. */
  vibrate(durationMs: number, strong = 0.5, weak = 0.3): void {
    if (!this.settings.vibration) return;
    const pad = this.pad();
    // Not in the standard everywhere; treated as best-effort.
    const actuator = (
      pad as unknown as {
        vibrationActuator?: { playEffect(type: string, options: unknown): Promise<unknown> };
      }
    )?.vibrationActuator;
    if (!actuator) return;
    void actuator
      .playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: strong,
        weakMagnitude: weak,
      })
      .catch(() => {
        // Some browsers reject rather than omitting the actuator. Silence is correct here.
      });
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
    this.index = null;
  }
}
