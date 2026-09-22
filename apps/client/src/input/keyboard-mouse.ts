/**
 * KeyboardMouseAdapter.
 *
 * Collects key state and raw mouse deltas between simulation ticks. Sensitivity and invert-Y are
 * applied HERE, before the values reach the router and the recorder, so a RunLog stores the
 * player's intent rather than their device's movement (ADR-001 in the Input System blueprint).
 * That keeps a log replayable regardless of what sensitivity the player used, and lets them change
 * settings without affecting comparability.
 */

import { Buttons, type ButtonMask } from '@rearena/protocol';
import {
  BUTTON_FOR_ACTION,
  DEFAULT_INPUT_SETTINGS,
  DEFAULT_MOUSE_BINDINGS,
  indexBindings,
  type Action,
  type InputSettings,
} from './bindings.js';

/** Accumulated input since the last tick, already scaled into turns. */
export interface RawInput {
  moveX: number;
  moveY: number;
  lookYawTurns: number;
  lookPitchTurns: number;
  buttons: ButtonMask;
  pausePressed: boolean;
}

export class KeyboardMouseAdapter {
  private settings: InputSettings = DEFAULT_INPUT_SETTINGS;
  private index = indexBindings(DEFAULT_INPUT_SETTINGS.bindings);
  private readonly held = new Set<Action>();
  private yawAccum = 0;
  private pitchAccum = 0;
  private pausePressed = false;
  private readonly detach: Array<() => void> = [];

  constructor(private readonly target: HTMLElement) {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = this.index.get(event.code);
      if (!action) return;
      if (action === 'pause') {
        if (!event.repeat) this.pausePressed = true;
        return;
      }
      // Space and the arrows scroll the page otherwise.
      event.preventDefault();
      this.held.add(action);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const action = this.index.get(event.code);
      if (action && action !== 'pause') this.held.delete(action);
    };
    const onMouseDown = (event: MouseEvent) => {
      const action = DEFAULT_MOUSE_BINDINGS[event.button];
      if (action) {
        event.preventDefault();
        this.held.add(action);
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      const action = DEFAULT_MOUSE_BINDINGS[event.button];
      if (action) this.held.delete(action);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== this.target) return;
      // Turns per 1000 pixels, so the number in settings is device independent.
      const scale = this.settings.mouseSensitivity / 1000;
      const ads = this.held.has('aim') ? this.settings.adsSensitivityScale : 1;
      this.yawAccum += event.movementX * scale * ads;
      const pitchSign = this.settings.invertY ? 1 : -1;
      this.pitchAccum += event.movementY * scale * ads * pitchSign;
    };
    const onContextMenu = (event: Event) => event.preventDefault();
    /** A lost window must not leave keys stuck down. */
    const onBlur = () => this.clearHeld();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.target.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    this.target.addEventListener('contextmenu', onContextMenu);

    this.detach.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => this.target.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => this.target.removeEventListener('contextmenu', onContextMenu),
    );
  }

  setSettings(settings: InputSettings): void {
    this.settings = settings;
    this.index = indexBindings(settings.bindings);
  }

  clearHeld(): void {
    this.held.clear();
  }

  /** Read and reset the accumulators. Called once per simulation tick by the router. */
  drain(): RawInput {
    let moveX = 0;
    let moveY = 0;
    if (this.held.has('moveRight')) moveX += 1;
    if (this.held.has('moveLeft')) moveX -= 1;
    if (this.held.has('moveForward')) moveY += 1;
    if (this.held.has('moveBack')) moveY -= 1;

    let buttons: ButtonMask = Buttons.None;
    for (const action of this.held) {
      const bit = BUTTON_FOR_ACTION[action];
      if (bit !== undefined) buttons |= bit;
    }

    const raw: RawInput = {
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
    return raw;
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
    this.held.clear();
  }
}
