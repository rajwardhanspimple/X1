/**
 * TouchAdapter: virtual stick, look zone and action buttons.
 *
 * Pointer events, not touch events. They unify mouse, touch and pen behind one API, and
 * setPointerCapture is what keeps the virtual stick following a thumb that slides outside the
 * element it started in. With raw touch events that case needs manual bookkeeping and gets it wrong
 * at the screen edge, which is exactly where a thumb ends up.
 *
 * Every contact is tracked by pointerId, so moving, looking and firing at the same time works
 * (AC-INP-TC-004.3). A single active-pointer variable would make the last touch win, which is the
 * usual reason mobile shooters feel broken.
 *
 * Look input is produced as a per-tick delta and scaled here, before the router sees it, exactly as
 * mouse movement is. That keeps a RunLog device independent: the verifier cannot tell whether a
 * frame came from a thumb or a mouse.
 */

import { Buttons, type ButtonMask } from '@rearena/protocol';

/** Actions a touch button can request. Named, so the layout and the adapter cannot disagree. */
export type TouchAction = 'fire' | 'aim' | 'reload' | 'jump' | 'crouch' | 'swap' | 'pause';

const BUTTON_FOR_ACTION: Partial<Record<TouchAction, ButtonMask>> = {
  fire: Buttons.Fire,
  aim: Buttons.Aim,
  reload: Buttons.Reload,
  jump: Buttons.Jump,
  crouch: Buttons.Crouch,
  swap: Buttons.Swap,
};

export interface TouchSettings {
  /** Turns of yaw per 1000 pixels of drag. */
  lookSensitivity: number;
  /** Multiplier applied while aiming. */
  adsSensitivityScale: number;
  invertY: boolean;
  /** Holding fire keeps firing. Off before the player changes it (AC-INP-TC-004.6). */
  autoFire: boolean;
}

export const DEFAULT_TOUCH_SETTINGS: TouchSettings = {
  lookSensitivity: 1.6,
  adsSensitivityScale: 0.55,
  invertY: false,
  autoFire: false,
};

/** Accumulated touch input since the last tick, already scaled into turns. */
export interface TouchInput {
  moveX: number;
  moveY: number;
  lookYawTurns: number;
  lookPitchTurns: number;
  buttons: ButtonMask;
  pausePressed: boolean;
}

/** Radius of the stick in CSS pixels. Beyond this the input is at full deflection. */
const STICK_RADIUS = 58;
/** Movement under this many pixels is ignored, so resting a thumb does not creep. */
const STICK_DEADZONE = 6;

interface StickContact {
  pointerId: number;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
}

interface LookContact {
  pointerId: number;
  lastX: number;
  lastY: number;
}

export interface TouchAdapterCallbacks {
  /** Move the visible stick. Called with null when the contact ends. */
  onStickMove?(state: { originX: number; originY: number; dx: number; dy: number } | null): void;
  onPausePressed?(): void;
}

export class TouchAdapter {
  private settings: TouchSettings = DEFAULT_TOUCH_SETTINGS;
  private stick: StickContact | null = null;
  private look: LookContact | null = null;
  /** Held actions, keyed by pointerId so two thumbs on two buttons both register. */
  private readonly held = new Map<number, TouchAction>();
  private yawAccum = 0;
  private pitchAccum = 0;
  private pausePressed = false;
  /** Set for one drain when auto-fire is off, so a tap always produces one fire frame. */
  private fireTapPending = false;
  private readonly detach: Array<() => void> = [];
  private enabled = false;

  constructor(
    private readonly stickZone: HTMLElement,
    private readonly lookZone: HTMLElement,
    private readonly callbacks: TouchAdapterCallbacks = {},
  ) {
    this.bindStick();
    this.bindLook();
  }

  setSettings(settings: TouchSettings): void {
    this.settings = settings;
  }

  getSettings(): TouchSettings {
    return this.settings;
  }

  /** Touch is only wired up on a touch device, so a desktop pointer cannot drive it. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private bindStick(): void {
    const onDown = (event: PointerEvent) => {
      if (!this.enabled || this.stick) return;
      /*
       * The stick recentres wherever the thumb lands rather than living at a fixed point. A fixed
       * stick makes the player hunt for it; a relocating one means the thumb is always centred,
       * which is what mobile shooters converged on.
       */
      this.stick = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
      };
      // Capture: the thumb will slide outside this element and must keep control of it.
      this.stickZone.setPointerCapture(event.pointerId);
      this.callbacks.onStickMove?.({
        originX: event.clientX,
        originY: event.clientY,
        dx: 0,
        dy: 0,
      });
      event.preventDefault();
    };

    const onMove = (event: PointerEvent) => {
      if (!this.stick || event.pointerId !== this.stick.pointerId) return;
      this.stick.currentX = event.clientX;
      this.stick.currentY = event.clientY;
      const dx = this.stick.currentX - this.stick.originX;
      const dy = this.stick.currentY - this.stick.originY;
      this.callbacks.onStickMove?.({
        originX: this.stick.originX,
        originY: this.stick.originY,
        dx,
        dy,
      });
      event.preventDefault();
    };

    const onUp = (event: PointerEvent) => {
      if (!this.stick || event.pointerId !== this.stick.pointerId) return;
      this.stick = null;
      this.callbacks.onStickMove?.(null);
      if (this.stickZone.hasPointerCapture(event.pointerId)) {
        this.stickZone.releasePointerCapture(event.pointerId);
      }
    };

    this.stickZone.addEventListener('pointerdown', onDown);
    this.stickZone.addEventListener('pointermove', onMove);
    this.stickZone.addEventListener('pointerup', onUp);
    this.stickZone.addEventListener('pointercancel', onUp);
    this.detach.push(
      () => this.stickZone.removeEventListener('pointerdown', onDown),
      () => this.stickZone.removeEventListener('pointermove', onMove),
      () => this.stickZone.removeEventListener('pointerup', onUp),
      () => this.stickZone.removeEventListener('pointercancel', onUp),
    );
  }

  private bindLook(): void {
    const onDown = (event: PointerEvent) => {
      if (!this.enabled || this.look) return;
      this.look = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
      this.lookZone.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const onMove = (event: PointerEvent) => {
      if (!this.look || event.pointerId !== this.look.pointerId) return;
      const dx = event.clientX - this.look.lastX;
      const dy = event.clientY - this.look.lastY;
      this.look.lastX = event.clientX;
      this.look.lastY = event.clientY;

      // Turns per 1000 pixels, so the sensitivity number means the same on any screen size.
      const aiming = this.isActionHeld('aim');
      const scale =
        (this.settings.lookSensitivity / 1000) *
        (aiming ? this.settings.adsSensitivityScale : 1);
      this.yawAccum += dx * scale;
      this.pitchAccum += dy * scale * (this.settings.invertY ? 1 : -1);
      event.preventDefault();
    };

    const onUp = (event: PointerEvent) => {
      if (!this.look || event.pointerId !== this.look.pointerId) return;
      this.look = null;
      if (this.lookZone.hasPointerCapture(event.pointerId)) {
        this.lookZone.releasePointerCapture(event.pointerId);
      }
    };

    this.lookZone.addEventListener('pointerdown', onDown);
    this.lookZone.addEventListener('pointermove', onMove);
    this.lookZone.addEventListener('pointerup', onUp);
    this.lookZone.addEventListener('pointercancel', onUp);
    this.detach.push(
      () => this.lookZone.removeEventListener('pointerdown', onDown),
      () => this.lookZone.removeEventListener('pointermove', onMove),
      () => this.lookZone.removeEventListener('pointerup', onUp),
      () => this.lookZone.removeEventListener('pointercancel', onUp),
    );
  }

  /**
   * Register an action button. The element owns its own press state so the visual and the input
   * cannot disagree.
   */
  bindButton(element: HTMLElement, action: TouchAction): void {
    const press = (event: PointerEvent) => {
      if (!this.enabled) return;
      element.dataset.pressed = 'true';
      element.setPointerCapture(event.pointerId);

      if (action === 'pause') {
        this.pausePressed = true;
        this.callbacks.onPausePressed?.();
      } else {
        this.held.set(event.pointerId, action);
        /*
         * With auto-fire off a tap must still fire once. A quick tap can begin and end inside one
         * tick, so the press is latched for exactly one drain rather than relying on the button
         * still being held when the tick runs.
         */
        if (action === 'fire' && !this.settings.autoFire) this.fireTapPending = true;
      }
      event.preventDefault();
    };

    const release = (event: PointerEvent) => {
      delete element.dataset.pressed;
      this.held.delete(event.pointerId);
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
    };

    element.addEventListener('pointerdown', press);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('pointerleave', release);
    this.detach.push(
      () => element.removeEventListener('pointerdown', press),
      () => element.removeEventListener('pointerup', release),
      () => element.removeEventListener('pointercancel', release),
      () => element.removeEventListener('pointerleave', release),
    );
  }

  private isActionHeld(action: TouchAction): boolean {
    for (const held of this.held.values()) {
      if (held === action) return true;
    }
    return false;
  }

  /** Clear everything. Called on pause, so a held button does not survive into the next round. */
  reset(): void {
    this.held.clear();
    this.stick = null;
    this.look = null;
    this.yawAccum = 0;
    this.pitchAccum = 0;
    this.fireTapPending = false;
    this.callbacks.onStickMove?.(null);
  }

  /** Read and reset the accumulators. Called once per simulation tick by the router. */
  drain(): TouchInput {
    let moveX = 0;
    let moveY = 0;

    if (this.stick) {
      const dx = this.stick.currentX - this.stick.originX;
      // Screen y grows downward; forward is negative dy.
      const dy = this.stick.originY - this.stick.currentY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > STICK_DEADZONE) {
        // Clamp to the stick radius, so a long drag is full speed rather than faster.
        const clamped = Math.min(1, distance / STICK_RADIUS);
        moveX = (dx / distance) * clamped;
        moveY = (dy / distance) * clamped;
      }
    }

    let buttons: ButtonMask = Buttons.None;
    for (const action of this.held.values()) {
      const bit = BUTTON_FOR_ACTION[action];
      if (bit !== undefined) buttons |= bit;
    }

    // Auto-fire off: fire only on the tick the tap was latched, then clear it.
    if (!this.settings.autoFire) {
      if (this.fireTapPending) {
        buttons |= Buttons.Fire;
        this.fireTapPending = false;
      } else {
        buttons &= ~Buttons.Fire;
      }
    }

    const input: TouchInput = {
      moveX,
      moveY,
      lookYawTurns: this.yawAccum,
      lookPitchTurns: this.pitchAccum,
      buttons,
      pausePressed: this.pausePressed,
    };

    this.yawAccum = 0;
    this.pitchAccum = 0;
    this.pausePressed = false;
    return input;
  }

  /** True when any contact is active, so the router knows touch is the live scheme. */
  hasContact(): boolean {
    return this.stick !== null || this.look !== null || this.held.size > 0;
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
    this.reset();
  }
}

export { STICK_RADIUS };
