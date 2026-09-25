import type { RenderSnapshot } from '@rearena/protocol';
import { MEDAL_NAMES } from '@rearena/sim';
import { subscribeAccessibility } from '../render/accessibility.js';

export interface HudEvent {
  kind: 'hit' | 'headshot' | 'kill' | 'medal' | 'damage' | 'reloadStart' | 'dryFire';
  medal?: number;
}

function el(tag: string, className: string, parent: HTMLElement): HTMLElement {
  const node = document.createElement(tag); node.className = className; parent.appendChild(node); return node;
}

type DamageEdge = 'front' | 'back' | 'left' | 'right';
const DOWN_VEIL_STYLE = ['position: fixed','inset: 0','pointer-events: none','opacity: 0','transition: opacity 700ms ease','background: radial-gradient(ellipse at center, rgba(30, 0, 0, 0.15) 0%, rgba(8, 0, 0, 0.78) 100%)','backdrop-filter: grayscale(0.85)','-webkit-backdrop-filter: grayscale(0.85)'].join('; ');

export class Hud {
  private readonly healthFill: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly ammoText: HTMLElement;
  private readonly reserveText: HTMLElement;
  private readonly timerText: HTMLElement;
  private readonly scoreText: HTMLElement;
  private readonly streakText: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitMarker: HTMLElement;
  private readonly killFeed: HTMLElement;
  private readonly callout: HTMLElement;
  private readonly downVeil: HTMLElement;
  private readonly downNotice: HTMLElement;
  private readonly damageVeil: HTMLElement;
  private readonly damageEdges: Record<DamageEdge, HTMLElement>;
  private hitMarkerUntil = 0;
  private calloutUntil = 0;
  private damageUntil = 0;
  private damageEdge: DamageEdge | null = null;
  private wasDown = false;
  private readonly feedEntries: Array<{ node: HTMLElement; until: number }> = [];
  private readonly unsubscribeAccessibility: () => void;

  constructor(root: HTMLElement) {
    const health = el('div', 'hud-health', root); this.healthFill = el('div', 'hud-health-fill', health); this.healthText = el('div', 'hud-health-text', health);
    const weapon = el('div', 'hud-weapon', root); this.ammoText = el('div', 'hud-ammo', weapon); this.reserveText = el('div', 'hud-reserve', weapon);
    const top = el('div', 'hud-top', root); this.timerText = el('div', 'hud-timer', top);
    const scoreBlock = el('div', 'hud-score-block', root); this.scoreText = el('div', 'hud-score', scoreBlock); this.streakText = el('div', 'hud-streak', scoreBlock);
    this.crosshair = el('div', 'hud-crosshair', root); el('span', 'hud-crosshair-dot', this.crosshair); this.hitMarker = el('div', 'hud-hitmarker', root);
    this.killFeed = el('div', 'hud-killfeed', root); this.callout = el('div', 'hud-callout', root);
    this.downVeil = el('div', 'hud-down-veil', root); this.downVeil.style.cssText = DOWN_VEIL_STYLE; this.downNotice = el('div', 'hud-down', root);
    this.damageVeil = el('div', 'hud-damage-veil', root);
    this.damageEdges = { front: el('div', 'hud-damage-edge hud-damage-front', root), back: el('div', 'hud-damage-edge hud-damage-back', root), left: el('div', 'hud-damage-edge hud-damage-left', root), right: el('div', 'hud-damage-edge hud-damage-right', root) };
    this.downNotice.setAttribute('role', 'status');
    this.unsubscribeAccessibility = subscribeAccessibility((settings) => {
      root.dataset.reduceMotion = String(settings.reduceMotion);
      root.dataset.crosshairStyle = settings.crosshairStyle;
      root.style.setProperty('--hud-scale', String(settings.hudScale));
      root.style.setProperty('--hud-opacity', String(settings.hudOpacity));
    });
  }

  update(snapshot: RenderSnapshot, now: number): void {
    const healthPct = Math.max(0, Math.min(100, snapshot.playerHealth));
    this.healthFill.style.width = `${healthPct}%`; this.healthFill.dataset.low = healthPct <= 30 ? 'true' : 'false'; this.healthText.textContent = String(Math.ceil(healthPct));
    this.ammoText.textContent = String(snapshot.ammo); this.reserveText.textContent = `/ ${snapshot.reserve}`; this.ammoText.dataset.empty = snapshot.ammo === 0 ? 'true' : 'false';
    const seconds = Math.ceil(snapshot.ticksRemaining / 60); this.timerText.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    this.scoreText.textContent = snapshot.score.toLocaleString();
    if (snapshot.streak > 1) { this.streakText.textContent = `${snapshot.streak} streak  x${snapshot.multiplier.toFixed(2)}`; this.streakText.dataset.visible = 'true'; } else this.streakText.dataset.visible = 'false';
    const down = snapshot.playerDownTicks > 0;
    if (down) { this.downNotice.dataset.visible = 'true'; this.downNotice.textContent = `Respawning in ${Math.ceil(snapshot.playerDownTicks / 60)}`; } else this.downNotice.dataset.visible = 'false';
    if (down !== this.wasDown) { this.wasDown = down; this.downVeil.style.opacity = down ? '1' : '0'; this.crosshair.style.visibility = down ? 'hidden' : ''; }
    this.hitMarker.dataset.visible = now < this.hitMarkerUntil ? 'true' : 'false'; this.callout.dataset.visible = now < this.calloutUntil ? 'true' : 'false';
    const damaged = now < this.damageUntil; this.damageVeil.dataset.visible = damaged ? 'true' : 'false';
    for (const [edge, node] of Object.entries(this.damageEdges)) node.dataset.visible = damaged && edge === this.damageEdge ? 'true' : 'false';
    while (this.feedEntries.length > 0 && this.feedEntries[0]!.until < now) this.feedEntries.shift()!.node.remove();
  }

  setSpread(normalised: number): void { const gap = 4 + Math.max(0, Math.min(1, normalised)) * 26; this.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`); }

  damageFrom(angleTurns: number, now: number): void {
    const t = ((angleTurns % 1) + 1) % 1;
    this.damageEdge = t < 0.125 || t >= 0.875 ? 'front' : t < 0.375 ? 'right' : t < 0.625 ? 'back' : 'left'; this.damageUntil = now + 260;
  }

  handleEvents(events: readonly HudEvent[], now: number): void {
    for (const event of events) {
      switch (event.kind) {
        case 'hit': this.hitMarkerUntil = now + 90; this.hitMarker.dataset.head = 'false'; break;
        case 'headshot': this.hitMarkerUntil = now + 140; this.hitMarker.dataset.head = 'true'; break;
        case 'kill': this.pushFeed('Eliminated', now); break;
        case 'medal': { const name = event.medal !== undefined ? MEDAL_NAMES[event.medal] : undefined; if (name) { this.callout.textContent = name; this.calloutUntil = now + 1800; } break; }
        case 'dryFire': this.pushFeed('Empty: press R', now); break;
        case 'reloadStart': this.pushFeed('Reloading', now); break;
      }
    }
  }

  private pushFeed(text: string, now: number): void {
    const node = el('div', 'hud-killfeed-entry', this.killFeed); node.textContent = text; node.setAttribute('role', 'status'); this.feedEntries.push({ node, until: now + 2600 });
    while (this.feedEntries.length > 5) this.feedEntries.shift()!.node.remove();
  }

  dispose(): void { this.unsubscribeAccessibility(); for (const entry of this.feedEntries) entry.node.remove(); this.feedEntries.length = 0; this.downVeil.remove(); }
}
