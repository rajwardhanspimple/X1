import { HapticsBridge } from '../input/haptics.js';
import { TouchAdapter, type TouchAction } from '../input/touch.js';
import {
  clampLayout,
  loadTouchState,
  type SafeArea,
  type TouchControlId,
  type TouchLayout,
} from '../input/touch-layout.js';
import { TouchLayoutEditor } from './touch-layout-editor.js';

const SYMBOLS: Record<TouchAction, string> = {
  fire: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/>',
  aim: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  reload: '<path d="M12 2v7M12 9l-3-3M12 9l3-3M8 11h8v11H8z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  jump: '<path d="M12 20V5M12 5l-5 5M12 5l5 5M5 22h14" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  crouch: '<path d="M12 4v11M12 15l-5-5M12 15l5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  swap: '<path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  pause: '<rect x="7" y="5" width="3.6" height="14" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" fill="currentColor"/>',
};
const LABELS: Record<TouchAction, string> = {
  fire: 'Fire',
  aim: 'Aim down sights',
  reload: 'Reload',
  jump: 'Jump',
  crouch: 'Crouch',
  swap: 'Switch weapon',
  pause: 'Pause',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}
function symbolButton(
  action: TouchAction,
  size: 'primary' | 'secondary',
  parent: HTMLElement,
): HTMLButtonElement {
  const node = el('button', `touch-button touch-button-${size}`, parent);
  node.type = 'button';
  node.dataset.action = action;
  node.setAttribute('aria-label', LABELS[action]);
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SYMBOLS[action]}</svg>`;
  return node;
}

export function deviceSupportsTouch(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 ||
      (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches))
  );
}

export interface TouchOverlayCallbacks {
  onPausePressed?(): void;
}

export class TouchOverlay {
  private readonly root: HTMLDivElement;
  private readonly stickZone: HTMLDivElement;
  private readonly stickRing: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly lookZone: HTMLDivElement;
  private readonly orientationGate: HTMLDivElement;
  private readonly editor: TouchLayoutEditor;
  private readonly haptics = new HapticsBridge();
  readonly adapter: TouchAdapter;
  private portrait = false;

  constructor(container: HTMLElement, callbacks: TouchOverlayCallbacks = {}) {
    this.root = el('div', 'touch-overlay', container);
    this.root.dataset.visible = 'false';
    this.stickZone = el('div', 'touch-stick-zone', this.root);
    this.stickRing = el('div', 'touch-stick-ring', this.stickZone);
    this.stickKnob = el('div', 'touch-stick-knob', this.stickZone);
    this.stickRing.dataset.visible = 'false';
    this.stickKnob.dataset.visible = 'false';
    this.lookZone = el('div', 'touch-look-zone', this.root);
    const primary = el('div', 'touch-cluster touch-cluster-primary', this.root);
    const fire = symbolButton('fire', 'primary', primary);
    const aim = symbolButton('aim', 'primary', primary);
    const secondary = el('div', 'touch-cluster touch-cluster-secondary', this.root);
    const reload = symbolButton('reload', 'secondary', secondary);
    const swap = symbolButton('swap', 'secondary', secondary);
    const left = el('div', 'touch-cluster touch-cluster-left', this.root);
    const jump = symbolButton('jump', 'secondary', left);
    const crouch = symbolButton('crouch', 'secondary', left);
    const top = el('div', 'touch-cluster touch-cluster-top', this.root);
    const pause = symbolButton('pause', 'secondary', top);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'touch-layout-open';
    edit.textContent = 'Layout';
    edit.setAttribute('aria-label', 'Edit touch layout');
    top.append(edit);
    this.adapter = new TouchAdapter(this.stickZone, this.lookZone, {
      onStickMove: (state) => this.renderStick(state),
      ...(callbacks.onPausePressed ? { onPausePressed: callbacks.onPausePressed } : {}),
      onHaptic: (phase) => (phase === 'press' ? this.haptics.press() : this.haptics.release()),
    });
    this.adapter.bindButton(fire, 'fire');
    this.adapter.bindButton(aim, 'aim');
    this.adapter.bindButton(reload, 'reload');
    this.adapter.bindButton(swap, 'swap');
    this.adapter.bindButton(jump, 'jump');
    this.adapter.bindButton(crouch, 'crouch');
    this.adapter.bindButton(pause, 'pause');
    this.editor = new TouchLayoutEditor(container, {
      adapter: this.adapter,
      haptics: this.haptics,
      onSaved: (layout, preferences) => {
        this.applyLayout(layout);
        this.haptics.setEnabled(preferences.hapticsEnabled);
      },
    });
    edit.onclick = () => this.editor.open();
    this.orientationGate = el('div', 'touch-orientation', container);
    this.orientationGate.dataset.visible = 'false';
    const icon = el('div', 'touch-orientation-icon', this.orientationGate);
    icon.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="14" y="6" width="20" height="34" rx="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    const text = el('p', 'touch-orientation-text', this.orientationGate);
    text.textContent = 'Rotate your device to play';
    this.applyLayout(loadTouchState(this.safeArea()).layout);
    this.watchOrientation();
  }

  private safeArea(): SafeArea {
    return {
      width: Math.max(typeof window === 'undefined' ? 1 : window.innerWidth, 1),
      height: Math.max(typeof window === 'undefined' ? 1 : window.innerHeight, 1),
    };
  }

  private applyLayout(layout: TouchLayout): void {
    const clamped = clampLayout(layout, this.safeArea());
    const nodes = this.root.querySelectorAll<HTMLElement>('[data-action]');
    for (const node of nodes) {
      const id = node.dataset.action as TouchControlId;
      const record = clamped[id];
      if (!record) continue;
      node.style.left = `${record.x * 100}%`;
      node.style.top = `${record.y * 100}%`;
      node.style.width = `${Math.max(record.width * this.safeArea().width, record.minSize)}px`;
      node.style.height = `${Math.max(record.height * this.safeArea().height, record.minSize)}px`;
      node.style.transform = 'translate(-50%, -50%)';
    }
    const stick = clamped.stick;
    this.stickZone.style.left = `${(stick.x + stick.width / 2) * 100}%`;
    this.stickZone.style.top = `${(stick.y + stick.height / 2) * 100}%`;
    this.stickZone.style.width = `${stick.width * 100}%`;
    this.stickZone.style.height = `${stick.height * 100}%`;
    const look = clamped.look;
    this.lookZone.style.left = `${look.x * 100}%`;
    this.lookZone.style.top = `${look.y * 100}%`;
    this.lookZone.style.width = `${look.width * 100}%`;
    this.lookZone.style.height = `${look.height * 100}%`;
    this.root.dataset.layout = 'custom';
  }

  private renderStick(state: { originX: number; originY: number; dx: number; dy: number } | null): void {
    if (!state) {
      this.stickRing.dataset.visible = 'false';
      this.stickKnob.dataset.visible = 'false';
      return;
    }
    const rect = this.stickZone.getBoundingClientRect();
    const x = state.originX - rect.left;
    const y = state.originY - rect.top;
    const distance = Math.hypot(state.dx, state.dy);
    const scale = distance > 58 ? 58 / distance : 1;
    this.stickRing.style.transform = `translate(${x}px, ${y}px)`;
    this.stickKnob.style.transform = `translate(${x + state.dx * scale}px, ${y + state.dy * scale}px)`;
    this.stickRing.dataset.visible = 'true';
    this.stickKnob.dataset.visible = 'true';
  }

  private watchOrientation(): void {
    const check = (): void => {
      this.portrait = window.innerHeight > window.innerWidth;
      const gate = this.portrait && this.adapter.isEnabled();
      this.orientationGate.dataset.visible = String(gate);
      if (gate) this.adapter.reset();
    };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    check();
  }

  isPortrait(): boolean {
    return this.portrait && this.adapter.isEnabled();
  }

  setVisible(visible: boolean): void {
    this.root.dataset.visible = String(visible);
    if (!visible) this.adapter.reset();
  }

  setEnabled(enabled: boolean): void {
    this.adapter.setEnabled(enabled);
    this.orientationGate.dataset.visible = String(enabled && this.portrait);
  }

  dispose(): void {
    this.adapter.dispose();
    this.editor.dispose();
    this.root.remove();
    this.orientationGate.remove();
  }
}
