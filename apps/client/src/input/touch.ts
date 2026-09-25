/**
 * TouchAdapter: virtual stick, look zone and action buttons.
 *
 * Pointer events unify mouse, touch and pen. Each contact is tracked by pointerId,
 * so moving, looking and firing can happen together. Settings are applied before
 * the router records an InputFrame.
 */
import { Buttons, type ButtonMask } from '@rearena/protocol';

export type TouchAction = 'fire' | 'aim' | 'reload' | 'jump' | 'crouch' | 'swap' | 'pause';
const BUTTON_FOR_ACTION: Partial<Record<TouchAction, ButtonMask>> = { fire: Buttons.Fire, aim: Buttons.Aim, reload: Buttons.Reload, jump: Buttons.Jump, crouch: Buttons.Crouch, swap: Buttons.Swap };
export interface TouchSettings { lookSensitivity: number; adsSensitivityScale: number; invertY: boolean; autoFire: boolean }
export const DEFAULT_TOUCH_SETTINGS: TouchSettings = { lookSensitivity: 1.6, adsSensitivityScale: 0.55, invertY: false, autoFire: false };
export interface TouchInput { moveX: number; moveY: number; lookYawTurns: number; lookPitchTurns: number; buttons: ButtonMask; pausePressed: boolean }
const STICK_RADIUS = 58;
const STICK_DEADZONE = 6;
interface StickContact { pointerId: number; originX: number; originY: number; currentX: number; currentY: number }
interface LookContact { pointerId: number; lastX: number; lastY: number }
export interface TouchAdapterCallbacks {
  onStickMove?(state: { originX: number; originY: number; dx: number; dy: number } | null): void;
  onPausePressed?(): void;
  onHaptic?(phase: 'press' | 'release'): void;
}

export class TouchAdapter {
  private settings: TouchSettings = { ...DEFAULT_TOUCH_SETTINGS };
  private stick: StickContact | null = null;
  private look: LookContact | null = null;
  private readonly held = new Map<number, TouchAction>();
  private yawAccum = 0;
  private pitchAccum = 0;
  private pausePressed = false;
  private fireTapPending = false;
  private readonly detach: Array<() => void> = [];
  private enabled = false;
  constructor(private readonly stickZone: HTMLElement, private readonly lookZone: HTMLElement, private readonly callbacks: TouchAdapterCallbacks = {}) { this.bindStick(); this.bindLook(); }
  setSettings(settings: TouchSettings): void { this.settings = { ...settings }; }
  getSettings(): TouchSettings { return { ...this.settings }; }
  setEnabled(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.reset(); }
  isEnabled(): boolean { return this.enabled; }
  addLookDelta(yawTurns: number, pitchTurns: number): void { if (!this.enabled) return; this.yawAccum += yawTurns; this.pitchAccum += pitchTurns; }
  private bindStick(): void {
    const onDown = (event: PointerEvent) => { if (!this.enabled || this.stick) return; this.stick = { pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, currentX: event.clientX, currentY: event.clientY }; this.stickZone.setPointerCapture(event.pointerId); this.callbacks.onStickMove?.({ originX: event.clientX, originY: event.clientY, dx: 0, dy: 0 }); event.preventDefault(); };
    const onMove = (event: PointerEvent) => { if (!this.stick || event.pointerId !== this.stick.pointerId) return; this.stick.currentX = event.clientX; this.stick.currentY = event.clientY; this.callbacks.onStickMove?.({ originX: this.stick.originX, originY: this.stick.originY, dx: event.clientX - this.stick.originX, dy: event.clientY - this.stick.originY }); event.preventDefault(); };
    const onUp = (event: PointerEvent) => { if (!this.stick || event.pointerId !== this.stick.pointerId) return; this.stick = null; this.callbacks.onStickMove?.(null); if (this.stickZone.hasPointerCapture(event.pointerId)) this.stickZone.releasePointerCapture(event.pointerId); };
    this.stickZone.addEventListener('pointerdown', onDown); this.stickZone.addEventListener('pointermove', onMove); this.stickZone.addEventListener('pointerup', onUp); this.stickZone.addEventListener('pointercancel', onUp);
    this.detach.push(() => this.stickZone.removeEventListener('pointerdown', onDown), () => this.stickZone.removeEventListener('pointermove', onMove), () => this.stickZone.removeEventListener('pointerup', onUp), () => this.stickZone.removeEventListener('pointercancel', onUp));
  }
  private bindLook(): void {
    const onDown = (event: PointerEvent) => { if (!this.enabled || this.look) return; this.look = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }; this.lookZone.setPointerCapture(event.pointerId); event.preventDefault(); };
    const onMove = (event: PointerEvent) => { if (!this.look || event.pointerId !== this.look.pointerId) return; const dx = event.clientX - this.look.lastX; const dy = event.clientY - this.look.lastY; this.look.lastX = event.clientX; this.look.lastY = event.clientY; const scale = (this.settings.lookSensitivity / 1000) * (this.isActionHeld('aim') ? this.settings.adsSensitivityScale : 1); this.yawAccum += dx * scale; this.pitchAccum += dy * scale * (this.settings.invertY ? 1 : -1); event.preventDefault(); };
    const onUp = (event: PointerEvent) => { if (!this.look || event.pointerId !== this.look.pointerId) return; this.look = null; if (this.lookZone.hasPointerCapture(event.pointerId)) this.lookZone.releasePointerCapture(event.pointerId); };
    this.lookZone.addEventListener('pointerdown', onDown); this.lookZone.addEventListener('pointermove', onMove); this.lookZone.addEventListener('pointerup', onUp); this.lookZone.addEventListener('pointercancel', onUp);
    this.detach.push(() => this.lookZone.removeEventListener('pointerdown', onDown), () => this.lookZone.removeEventListener('pointermove', onMove), () => this.lookZone.removeEventListener('pointerup', onUp), () => this.lookZone.removeEventListener('pointercancel', onUp));
  }
  bindButton(element: HTMLElement, action: TouchAction): void {
    const press = (event: PointerEvent) => { if (!this.enabled) return; element.dataset.pressed = 'true'; element.setPointerCapture(event.pointerId); this.callbacks.onHaptic?.('press'); if (action === 'pause') { if (this.callbacks.onPausePressed) { this.pausePressed = false; this.callbacks.onPausePressed(); } else this.pausePressed = true; } else { this.held.set(event.pointerId, action); if (action === 'fire' && !this.settings.autoFire) this.fireTapPending = true; } event.preventDefault(); };
    const release = (event: PointerEvent) => { delete element.dataset.pressed; this.held.delete(event.pointerId); this.callbacks.onHaptic?.('release'); if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); };
    element.addEventListener('pointerdown', press); element.addEventListener('pointerup', release); element.addEventListener('pointercancel', release); element.addEventListener('pointerleave', release);
    this.detach.push(() => element.removeEventListener('pointerdown', press), () => element.removeEventListener('pointerup', release), () => element.removeEventListener('pointercancel', release), () => element.removeEventListener('pointerleave', release));
  }
  private isActionHeld(action: TouchAction): boolean { for (const held of this.held.values()) if (held === action) return true; return false; }
  reset(): void { this.held.clear(); this.stick = null; this.look = null; this.yawAccum = 0; this.pitchAccum = 0; this.pausePressed = false; this.fireTapPending = false; this.callbacks.onStickMove?.(null); }
  drain(): TouchInput { let moveX = 0; let moveY = 0; if (this.stick) { const dx = this.stick.currentX - this.stick.originX; const dy = this.stick.originY - this.stick.currentY; const distance = Math.sqrt(dx * dx + dy * dy); if (distance > STICK_DEADZONE) { const clamped = Math.min(1, distance / STICK_RADIUS); moveX = dx / distance * clamped; moveY = dy / distance * clamped; } } let buttons: ButtonMask = Buttons.None; for (const action of this.held.values()) { const bit = BUTTON_FOR_ACTION[action]; if (bit !== undefined) buttons |= bit; } if (!this.settings.autoFire) { if (this.fireTapPending) { buttons |= Buttons.Fire; this.fireTapPending = false; } else buttons &= ~Buttons.Fire; } const input = { moveX, moveY, lookYawTurns: this.yawAccum, lookPitchTurns: this.pitchAccum, buttons, pausePressed: this.pausePressed }; this.yawAccum = 0; this.pitchAccum = 0; this.pausePressed = false; return input; }
  hasContact(): boolean { return this.stick !== null || this.look !== null || this.held.size > 0; }
  dispose(): void { for (const off of this.detach) off(); this.detach.length = 0; this.reset(); }
}
export { STICK_RADIUS };
