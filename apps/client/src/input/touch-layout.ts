export type TouchControlId =
  'stick' | 'look' | 'fire' | 'aim' | 'reload' | 'swap' | 'jump' | 'crouch' | 'pause';

export interface TouchLayoutRecord {
  x: number;
  y: number;
  width: number;
  height: number;
  minSize: number;
}

export type TouchLayout = Record<TouchControlId, TouchLayoutRecord>;

export interface TouchPreferences {
  gyroEnabled: boolean;
  hapticsEnabled: boolean;
}

export interface TouchState {
  layout: TouchLayout;
  preferences: TouchPreferences;
}

export interface SafeArea {
  width: number;
  height: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export const TOUCH_LAYOUT_KEY = 'rearena.touch.layout.v1';
export const TOUCH_PREFERENCES_KEY = 'rearena.touch.preferences.v1';

const frequent = (x: number, y: number): TouchLayoutRecord => ({
  x,
  y,
  width: 0.08,
  height: 0.08,
  minSize: 64,
});
const secondary = (x: number, y: number): TouchLayoutRecord => ({
  x,
  y,
  width: 0.065,
  height: 0.065,
  minSize: 44,
});

export const DEFAULT_TOUCH_LAYOUT: TouchLayout = {
  stick: { x: 0.22, y: 0.72, width: 0.45, height: 0.72, minSize: 44 },
  look: { x: 0.725, y: 0.5, width: 0.55, height: 1, minSize: 44 },
  fire: frequent(0.84, 0.82),
  aim: frequent(0.94, 0.82),
  reload: secondary(0.82, 0.66),
  swap: secondary(0.9, 0.66),
  jump: secondary(0.08, 0.78),
  crouch: secondary(0.08, 0.9),
  pause: secondary(0.5, 0.08),
};

export const DEFAULT_TOUCH_PREFERENCES: TouchPreferences = {
  gyroEnabled: false,
  hapticsEnabled: true,
};

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function clampRecord(record: TouchLayoutRecord, area: SafeArea): TouchLayoutRecord {
  const minWidth = Math.max(record.minSize / Math.max(area.width, 1), 0.001);
  const minHeight = Math.max(record.minSize / Math.max(area.height, 1), 0.001);
  const width = Math.min(1, Math.max(minWidth, finite(record.width, minWidth)));
  const height = Math.min(1, Math.max(minHeight, finite(record.height, minHeight)));
  return {
    x: Math.min(1 - width, Math.max(0, finite(record.x, 0))),
    y: Math.min(1 - height, Math.max(0, finite(record.y, 0))),
    width,
    height,
    minSize: Math.max(44, finite(record.minSize, 44)),
  };
}

export function clampLayout(layout: Partial<TouchLayout>, area: SafeArea): TouchLayout {
  const result = {} as TouchLayout;
  for (const id of Object.keys(DEFAULT_TOUCH_LAYOUT) as TouchControlId[]) {
    result[id] = clampRecord({ ...DEFAULT_TOUCH_LAYOUT[id], ...(layout[id] ?? {}) }, area);
  }
  return result;
}

export function normaliseLayout(layout: Partial<TouchLayout>, area: SafeArea): TouchLayout {
  return clampLayout(layout, area);
}

function read<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function loadTouchState(area: SafeArea): TouchState {
  const savedPreferences = read<Partial<TouchPreferences>>(TOUCH_PREFERENCES_KEY);
  return {
    layout: clampLayout(read<Partial<TouchLayout>>(TOUCH_LAYOUT_KEY) ?? {}, area),
    preferences: {
      ...DEFAULT_TOUCH_PREFERENCES,
      ...(savedPreferences ?? {}),
    },
  };
}

export function saveTouchState(state: TouchState, area: SafeArea): void {
  const layout = clampLayout(state.layout, area);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TOUCH_LAYOUT_KEY, JSON.stringify(layout));
    localStorage.setItem(
      TOUCH_PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_TOUCH_PREFERENCES, ...state.preferences }),
    );
  } catch {
    // Private browsing can reject storage. Touch play remains usable for this session.
  }
}

export function resetTouchState(area: SafeArea): TouchState {
  const state = {
    layout: clampLayout(DEFAULT_TOUCH_LAYOUT, area),
    preferences: { ...DEFAULT_TOUCH_PREFERENCES },
  };
  saveTouchState(state, area);
  return state;
}
