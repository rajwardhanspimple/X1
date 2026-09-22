/**
 * Default bindings and input settings.
 *
 * The defaults are stated in the Controls and Input requirements, so they live in one place and
 * are read by both the adapters and the settings UI (WO-31 syncs them to the account).
 */

import { Buttons, type ButtonMask } from '@rearena/protocol';

/** Action names are stable identifiers; bindings and UI labels both key off them. */
export type Action =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'crouch'
  | 'jump'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'swap'
  | 'pause';

/** Movement actions produce an axis, not a button, so they are handled separately. */
export const BUTTON_FOR_ACTION: Partial<Record<Action, ButtonMask>> = {
  sprint: Buttons.Sprint,
  crouch: Buttons.Crouch,
  jump: Buttons.Jump,
  fire: Buttons.Fire,
  aim: Buttons.Aim,
  reload: Buttons.Reload,
  swap: Buttons.Swap,
};

/** KeyboardEvent.code values, so bindings survive a layout change. */
export type KeyBindings = Record<Action, string[]>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft'],
  jump: ['Space'],
  fire: [],
  aim: [],
  reload: ['KeyR'],
  swap: ['KeyQ'],
  pause: ['Escape', 'KeyP'],
};

/** Mouse buttons by MouseEvent.button. */
export const DEFAULT_MOUSE_BINDINGS: Record<number, Action> = {
  0: 'fire',
  2: 'aim',
};

export interface InputSettings {
  bindings: KeyBindings;
  /** Turns of yaw per 1000 pixels of mouse movement. 0.5 is a middle-of-the-road setting. */
  mouseSensitivity: number;
  /** Multiplier applied while aiming down sights. */
  adsSensitivityScale: number;
  invertY: boolean;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  bindings: DEFAULT_KEY_BINDINGS,
  mouseSensitivity: 0.5,
  adsSensitivityScale: 0.6,
  invertY: false,
};

/** Reverse index from key code to action, rebuilt whenever bindings change. */
export function indexBindings(bindings: KeyBindings): Map<string, Action> {
  const index = new Map<string, Action>();
  for (const [action, codes] of Object.entries(bindings) as Array<[Action, string[]]>) {
    for (const code of codes) index.set(code, action);
  }
  return index;
}

/** Codes bound to more than one action, for the settings editor to flag. */
export function findConflicts(bindings: KeyBindings): Map<string, Action[]> {
  const seen = new Map<string, Action[]>();
  for (const [action, codes] of Object.entries(bindings) as Array<[Action, string[]]>) {
    for (const code of codes) {
      const list = seen.get(code) ?? [];
      list.push(action);
      seen.set(code, list);
    }
  }
  for (const [code, actions] of seen) {
    if (actions.length < 2) seen.delete(code);
  }
  return seen;
}
