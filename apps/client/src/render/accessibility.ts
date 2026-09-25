/** Local, presentation-only accessibility preferences. */

export type AccessibilityPalette = 'standard' | 'deuteranopia' | 'protanopia' | 'tritanopia';
export type CrosshairStyle = 'classic' | 'dot' | 'plus' | 'circle';
export type CrosshairColour = 'white' | 'cyan' | 'yellow' | 'magenta';

export interface AccessibilitySettings {
  hudScale: number;
  hudOpacity: number;
  crosshairStyle: CrosshairStyle;
  crosshairColour: CrosshairColour;
  palette: AccessibilityPalette;
  reduceMotion: boolean;
}

export interface PaletteColours {
  enemy: string;
  friendly: string;
  objective: string;
  damage: string;
  success: string;
}

export const ACCESSIBILITY_STORAGE_KEY = 'rearena.accessibility.v1';
export const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilitySettings = {
  hudScale: 1,
  hudOpacity: 1,
  crosshairStyle: 'classic',
  crosshairColour: 'white',
  palette: 'standard',
  reduceMotion: false,
};

const PALETTES: Record<AccessibilityPalette, PaletteColours> = {
  standard: {
    enemy: '#e0644f',
    friendly: '#4fd1c5',
    objective: '#e0a94f',
    damage: '#f2565b',
    success: '#4fd1c5',
  },
  deuteranopia: {
    enemy: '#d55e00',
    friendly: '#0072b2',
    objective: '#f0e442',
    damage: '#cc79a7',
    success: '#0072b2',
  },
  protanopia: {
    enemy: '#d55e00',
    friendly: '#56b4e9',
    objective: '#f0e442',
    damage: '#cc79a7',
    success: '#56b4e9',
  },
  tritanopia: {
    enemy: '#d55e00',
    friendly: '#009e73',
    objective: '#e69f00',
    damage: '#cc79a7',
    success: '#009e73',
  },
};

const CROSSHAIR_COLOURS: Record<CrosshairColour, string> = {
  white: '#f2f4f8',
  cyan: '#4fd1c5',
  yellow: '#f0e442',
  magenta: '#cc79a7',
};

let current = loadAccessibilitySettings();
const listeners = new Set<(settings: AccessibilitySettings) => void>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validSettings(value: unknown): AccessibilitySettings {
  const input = value && typeof value === 'object' ? (value as Partial<AccessibilitySettings>) : {};
  return {
    hudScale: clamp(typeof input.hudScale === 'number' ? input.hudScale : 1, 0.75, 1.5),
    hudOpacity: clamp(typeof input.hudOpacity === 'number' ? input.hudOpacity : 1, 0.5, 1),
    crosshairStyle:
      input.crosshairStyle === 'dot' ||
      input.crosshairStyle === 'plus' ||
      input.crosshairStyle === 'circle'
        ? input.crosshairStyle
        : 'classic',
    crosshairColour:
      input.crosshairColour === 'cyan' ||
      input.crosshairColour === 'yellow' ||
      input.crosshairColour === 'magenta'
        ? input.crosshairColour
        : 'white',
    palette:
      input.palette === 'deuteranopia' ||
      input.palette === 'protanopia' ||
      input.palette === 'tritanopia'
        ? input.palette
        : 'standard',
    reduceMotion: input.reduceMotion === true,
  };
}

export function loadAccessibilitySettings(): AccessibilitySettings {
  try {
    const raw = globalThis.localStorage?.getItem(ACCESSIBILITY_STORAGE_KEY);
    return raw ? validSettings(JSON.parse(raw)) : { ...DEFAULT_ACCESSIBILITY_SETTINGS };
  } catch {
    return { ...DEFAULT_ACCESSIBILITY_SETTINGS };
  }
}

export function saveAccessibilitySettings(settings: AccessibilitySettings): void {
  try {
    globalThis.localStorage?.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Storage can be disabled. */
  }
}

export function getAccessibilitySettings(): AccessibilitySettings {
  return { ...current };
}

export function setAccessibilitySettings(
  patch: Partial<AccessibilitySettings>,
): AccessibilitySettings {
  current = validSettings({ ...current, ...patch });
  saveAccessibilitySettings(current);
  applyAccessibilitySettings(current);
  for (const listener of listeners) listener({ ...current });
  return { ...current };
}

export function subscribeAccessibility(
  listener: (settings: AccessibilitySettings) => void,
): () => void {
  listeners.add(listener);
  listener({ ...current });
  return () => listeners.delete(listener);
}

export function paletteColours(palette: AccessibilityPalette = current.palette): PaletteColours {
  return { ...PALETTES[palette] };
}
export function crosshairColour(colour: CrosshairColour = current.crosshairColour): string {
  return CROSSHAIR_COLOURS[colour];
}

export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function installStyleRules(): void {
  if (typeof document === 'undefined' || document.getElementById('accessibility-style-rules'))
    return;
  const style = document.createElement('style');
  style.id = 'accessibility-style-rules';
  style.textContent = `
    .hud-root { transform: scale(var(--hud-scale, 1)); transform-origin: center; opacity: var(--hud-opacity, 1); }
    .hud-crosshair::before, .hud-crosshair::after, .hud-crosshair-dot { background: var(--crosshair-colour, #f2f4f8); }
    .hud-crosshair::before { box-shadow: 0 calc(2 * var(--gap) + 8px) 0 var(--crosshair-colour, #f2f4f8); }
    .hud-crosshair::after { box-shadow: calc(2 * var(--gap) + 8px) 0 0 var(--crosshair-colour, #f2f4f8); }
    [data-reduce-motion='true'] *, [data-reduce-motion='true'] *::before, [data-reduce-motion='true'] *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
    [data-crosshair-style='dot'] .hud-crosshair::before, [data-crosshair-style='dot'] .hud-crosshair::after { display: none; }
    [data-crosshair-style='plus'] .hud-crosshair::before, [data-crosshair-style='plus'] .hud-crosshair::after { width: 12px; height: 3px; }
    [data-crosshair-style='circle'] .hud-crosshair { width: 24px; height: 24px; margin: -12px; border: 2px solid var(--crosshair-colour, #f2f4f8); border-radius: 50%; }
  `;
  document.head.appendChild(style);
}

export function applyAccessibilitySettings(settings: AccessibilitySettings): void {
  if (typeof document === 'undefined') return;
  installStyleRules();
  const root = document.documentElement;
  root.dataset.accessibilityPalette = settings.palette;
  root.dataset.reduceMotion = String(settings.reduceMotion);
  root.dataset.reduceMotion = String(settings.reduceMotion);
  root.dataset.crosshairStyle = settings.crosshairStyle;
  root.style.setProperty('--hud-scale', String(settings.hudScale));
  root.style.setProperty('--hud-opacity', String(settings.hudOpacity));
  root.style.setProperty('--crosshair-colour', crosshairColour(settings.crosshairColour));
  const colours = paletteColours(settings.palette);
  root.style.setProperty('--semantic-enemy', colours.enemy);
  root.style.setProperty('--semantic-friendly', colours.friendly);
  root.style.setProperty('--semantic-objective', colours.objective);
  root.style.setProperty('--semantic-damage', colours.damage);
  root.style.setProperty('--semantic-success', colours.success);
}

function makeOption(
  parent: HTMLElement,
  label: string,
  key: keyof AccessibilitySettings,
  value: string,
  selected: boolean,
): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'option accessibility-option';
  node.dataset.selected = String(selected);
  node.textContent = label;
  node.addEventListener('click', () => {
    const next: Partial<AccessibilitySettings> = {
      [key]:
        key === 'reduceMotion'
          ? value === 'true'
          : key === 'hudScale' || key === 'hudOpacity'
            ? Number(value)
            : value,
    };
    setAccessibilitySettings(next);
    const group = parent.querySelectorAll<HTMLButtonElement>('.accessibility-option');
    group.forEach((option) => {
      option.dataset.selected = 'false';
    });
    node.dataset.selected = 'true';
  });
  parent.appendChild(node);
  return node;
}

export function mountAccessibilitySettings(settingsScreen: HTMLElement): void {
  if (settingsScreen.querySelector('[data-accessibility-settings]')) return;
  const section = document.createElement('section');
  section.className = 'setup-block accessibility-settings';
  section.dataset.accessibilitySettings = 'true';
  section.innerHTML =
    '<h2 class="screen-subtitle">Accessibility</h2><p class="settings-note accessibility-description">Changes apply immediately and are saved on this device.</p>';
  const settings = getAccessibilitySettings();
  const add = (
    label: string,
    key: keyof AccessibilitySettings,
    values: Array<[string, string]>,
  ) => {
    const title = document.createElement('h3');
    title.className = 'accessibility-label';
    title.textContent = label;
    section.appendChild(title);
    const row = document.createElement('div');
    row.className = 'settings-row';
    section.appendChild(row);
    for (const [text, value] of values)
      makeOption(row, text, key, value, String(settings[key]) === value);
  };
  add('HUD scale', 'hudScale', [
    ['75%', '0.75'],
    ['100%', '1'],
    ['125%', '1.25'],
    ['150%', '1.5'],
  ]);
  add('HUD opacity', 'hudOpacity', [
    ['50%', '0.5'],
    ['75%', '0.75'],
    ['100%', '1'],
  ]);
  add('Crosshair style', 'crosshairStyle', [
    ['Classic', 'classic'],
    ['Dot', 'dot'],
    ['Plus', 'plus'],
    ['Circle', 'circle'],
  ]);
  add('Crosshair colour', 'crosshairColour', [
    ['White', 'white'],
    ['Cyan', 'cyan'],
    ['Yellow', 'yellow'],
    ['Magenta', 'magenta'],
  ]);
  add('Colour-blind palette', 'palette', [
    ['Standard', 'standard'],
    ['Deuteranopia', 'deuteranopia'],
    ['Protanopia', 'protanopia'],
    ['Tritanopia', 'tritanopia'],
  ]);
  add('Reduce Motion', 'reduceMotion', [
    ['Off', 'false'],
    ['On', 'true'],
  ]);
  settingsScreen.appendChild(section);
}

function installAccessibilityUi(): void {
  if (typeof document === 'undefined') return;
  applyAccessibilitySettings(current);
  const mount = () => {
    const screen = document.querySelector<HTMLElement>('.screen-settings');
    if (screen) mountAccessibilitySettings(screen);
  };
  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
}

installAccessibilityUi();
