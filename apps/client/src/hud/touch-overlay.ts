/**
 * Touch overlay: the landscape control layout.
 *
 * Layout choices follow the Knowledge Base guidance on game controls:
 *
 * Frequently used controls (fire, aim) are 64 px; secondary ones (reload, jump, crouch, swap) are
 * 52 px. Both clear the 44 pt floor comfortably at typical device pixel ratios, and the extra size
 * on fire and aim matters because those are pressed under pressure.
 *
 * Buttons carry drawn symbols for the action rather than key names. A label reading "R" or "X" means
 * nothing on a phone, and the guidance is explicit that controller-style naming is worse than
 * artwork that shows what the button does.
 *
 * Pause sits top-centre, deliberately far from both thumb zones, so it cannot be caught mid-firefight.
 *
 * Everything respects safe-area insets, so a notch or a home indicator never overlaps a control.
 */

import { TouchAdapter, type TouchAction } from '../input/touch.js';

/** Inline SVG rather than an icon font or images: no request, and it scales cleanly. */
const SYMBOLS: Record<TouchAction, string> = {
  // Crosshair in a ring.
  fire: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M12 1.4v4M12 18.6v4M1.4 12h4M18.6 12h4" stroke="currentColor" stroke-width="1.8"/>',
  // An eye, for looking down the sight.
  aim: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  // A magazine with an arrow going in.
  reload:
    '<rect x="8" y="11" width="8" height="11" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v7M12 9l-3-3M12 9l3-3" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  // An arrow up off a baseline.
  jump: '<path d="M12 20V5M12 5l-5 5M12 5l5 5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 22h14" stroke="currentColor" stroke-width="1.8"/>',
  // An arrow down onto a baseline.
  crouch:
    '<path d="M12 4v11M12 15l-5-5M12 15l5-5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 20h14" stroke="currentColor" stroke-width="1.8"/>',
  // Two arrows swapping.
  swap: '<path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  // Two bars.
  pause:
    '<rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor"/>',
};

/** Labels are for assistive technology only; the visible control is the symbol. */
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
): HTMLElement {
  const node = el('button', `touch-button touch-button-${size}`, parent);
  node.type = 'button';
  node.dataset.action = action;
  // The visible content is artwork; the accessible name comes from the label.
  node.setAttribute('aria-label', LABELS[action]);
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SYMBOLS[action]}</svg>`;
  return node;
}

/** True when the device actually reports touch, so a desktop mouse cannot drive the overlay. */
export function deviceSupportsTouch(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    navigator.maxTouchPoints > 0 ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  );
}

export interface TouchOverlayCallbacks {
  onPausePressed?(): void;
}

export class TouchOverlay {
  private readonly root: HTMLElement;
  private readonly stickZone: HTMLElement;
  private readonly stickRing: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly lookZone: HTMLElement;
  private readonly orientationGate: HTMLElement;
  readonly adapter: TouchAdapter;

  private portrait = false;

  constructor(container: HTMLElement, callbacks: TouchOverlayCallbacks = {}) {
    this.root = el('div', 'touch-overlay', container);
    this.root.dataset.visible = 'false';

    // Left half: movement. The whole zone is the stick, not a fixed circle.
    this.stickZone = el('div', 'touch-stick-zone', this.root);
    this.stickRing = el('div', 'touch-stick-ring', this.stickZone);
    this.stickKnob = el('div', 'touch-stick-knob', this.stickZone);
    this.stickRing.dataset.visible = 'false';
    this.stickKnob.dataset.visible = 'false';

    // Right half: look. Buttons sit on top of it and take their own pointers.
    this.lookZone = el('div', 'touch-look-zone', this.root);

    // Primary actions, bottom right, under the thumb.
    const primary = el('div', 'touch-cluster touch-cluster-primary', this.root);
    const fire = symbolButton('fire', 'primary', primary);
    const aim = symbolButton('aim', 'primary', primary);

    // Secondary actions, above and left of the primaries, still within thumb reach.
    const secondary = el('div', 'touch-cluster touch-cluster-secondary', this.root);
    const reload = symbolButton('reload', 'secondary', secondary);
    const swap = symbolButton('swap', 'secondary', secondary);

    // Movement modifiers sit on the left, so they are reachable without leaving the stick.
    const left = el('div', 'touch-cluster touch-cluster-left', this.root);
    const jump = symbolButton('jump', 'secondary', left);
    const crouch = symbolButton('crouch', 'secondary', left);

    // Pause, top centre, away from both thumbs so it cannot be hit during a firefight.
    const top = el('div', 'touch-cluster touch-cluster-top', this.root);
    const pause = symbolButton('pause', 'secondary', top);

    this.adapter = new TouchAdapter(this.stickZone, this.lookZone, {
      onStickMove: (state) => this.renderStick(state),
      ...(callbacks.onPausePressed ? { onPausePressed: callbacks.onPausePressed } : {}),
    });

    this.adapter.bindButton(fire, 'fire');
    this.adapter.bindButton(aim, 'aim');
    this.adapter.bindButton(reload, 'reload');
    this.adapter.bindButton(swap, 'swap');
    this.adapter.bindButton(jump, 'jump');
    this.adapter.bindButton(crouch, 'crouch');
    this.adapter.bindButton(pause, 'pause');

    // Orientation gate. Portrait is blocked rather than supported: the layout needs the width, and
    // a cramped portrait layout is worse than asking the player to rotate (AC-INP-TC-001.5).
    this.orientationGate = el('div', 'touch-orientation', container);
    this.orientationGate.dataset.visible = 'false';
    const icon = el('div', 'touch-orientation-icon', this.orientationGate);
    icon.innerHTML =
      '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="14" y="6" width="20" height="34" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M38 30a16 16 0 0 1-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M29 39l4 1-1-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const text = el('p', 'touch-orientation-text', this.orientationGate);
    text.textContent = 'Rotate your device to play';

    this.watchOrientation();
  }

  /** Draw the stick where the thumb actually is. */
  private renderStick(
    state: { originX: number; originY: number; dx: number; dy: number } | null,
  ): void {
    if (!state) {
      this.stickRing.dataset.visible = 'false';
      this.stickKnob.dataset.visible = 'false';
      return;
    }

    const rect = this.stickZone.getBoundingClientRect();
    const originX = state.originX - rect.left;
    const originY = state.originY - rect.top;

    // Clamp the knob to the ring, so it reads as a stick rather than a free-floating dot.
    const distance = Math.sqrt(state.dx * state.dx + state.dy * state.dy);
    const limit = 58;
    const scale = distance > limit ? limit / distance : 1;

    this.stickRing.style.transform = `translate(${originX}px, ${originY}px)`;
    this.stickRing.dataset.visible = 'true';
    this.stickKnob.style.transform = `translate(${originX + state.dx * scale}px, ${
      originY + state.dy * scale
    }px)`;
    this.stickKnob.dataset.visible = 'true';
  }

  private watchOrientation(): void {
    const check = () => {
      this.portrait = window.innerHeight > window.innerWidth;
      // Only gate when touch is the active scheme; a narrow desktop window is not a problem.
      const gate = this.portrait && this.adapter.isEnabled();
      this.orientationGate.dataset.visible = String(gate);
      if (gate) this.adapter.reset();
    };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    check();
  }

  /** True while the device is held in portrait, so the round can stay paused. */
  isPortrait(): boolean {
    return this.portrait && this.adapter.isEnabled();
  }

  /** Show the controls only while a round is live. */
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
    this.root.remove();
    this.orientationGate.remove();
  }
}
