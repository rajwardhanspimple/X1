/**
 * Heads-up display.
 *
 * A DOM overlay above the canvas, updated by writing to text nodes. No framework: the HUD updates
 * every frame, and a React re-render at 60 Hz would cost more than everything it draws. React owns
 * the menus (WO-47), where updates are rare and accessibility matters more.
 *
 * Text sizes follow the Knowledge Base guidance on game legibility: nothing below 12 px, and every
 * value has a scrim behind it so it stays readable against a bright or dark part of the arena.
 *
 * ## Damage is directional, not a wash
 *
 * The damage cue used to be a full-screen red overlay. It said "you were hit" and nothing else: a
 * shot from behind looked identical to a shot from the front, so the player learned the least useful
 * thing at the moment they most needed to know where to turn.
 *
 * It is now four edge indicators. The edge nearest the attacker lights, computed from the attacker's
 * bearing against the player's current facing, so the cue points somewhere rather than covering
 * everything. A faint full-frame tint remains on top, because an edge alone can be missed by a player
 * already looking at it, but the strong red field is gone.
 */

import type { RenderSnapshot } from '@rearena/protocol';
import { MEDAL_NAMES } from '@rearena/sim';

export interface HudEvent {
  kind: 'hit' | 'headshot' | 'kill' | 'medal' | 'damage' | 'reloadStart' | 'dryFire';
  medal?: number;
}

function el(tag: string, className: string, parent: HTMLElement): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

/** Which screen edge a damage direction maps to. */
type DamageEdge = 'front' | 'back' | 'left' | 'right';


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
  private readonly downNotice: HTMLElement;
  /** Faint full-frame tint, kept so an edge cue cannot be missed entirely. */
  private readonly damageVeil: HTMLElement;
  /** The four directional edges. */
  private readonly damageEdges: Record<DamageEdge, HTMLElement>;

  private hitMarkerUntil = 0;
  private calloutUntil = 0;
  private damageUntil = 0;
  private damageEdge: DamageEdge | null = null;
  private readonly feedEntries: Array<{ node: HTMLElement; until: number }> = [];

  constructor(root: HTMLElement) {
    const health = el('div', 'hud-health', root);
    this.healthFill = el('div', 'hud-health-fill', health);
    this.healthText = el('div', 'hud-health-text', health);

    const weapon = el('div', 'hud-weapon', root);
    this.ammoText = el('div', 'hud-ammo', weapon);
    this.reserveText = el('div', 'hud-reserve', weapon);

    const top = el('div', 'hud-top', root);
    this.timerText = el('div', 'hud-timer', top);

    const scoreBlock = el('div', 'hud-score-block', root);
    this.scoreText = el('div', 'hud-score', scoreBlock);
    this.streakText = el('div', 'hud-streak', scoreBlock);

    this.crosshair = el('div', 'hud-crosshair', root);
    el('span', 'hud-crosshair-dot', this.crosshair);
    this.hitMarker = el('div', 'hud-hitmarker', root);

    this.killFeed = el('div', 'hud-killfeed', root);
    this.callout = el('div', 'hud-callout', root);
    this.downNotice = el('div', 'hud-down', root);

    // Damage indicator: a faint veil plus one lit edge.
    this.damageVeil = el('div', 'hud-damage-veil', root);
    this.damageEdges = {
      front: el('div', 'hud-damage-edge hud-damage-front', root),
      back: el('div', 'hud-damage-edge hud-damage-back', root),
      left: el('div', 'hud-damage-edge hud-damage-left', root),
      right: el('div', 'hud-damage-edge hud-damage-right', root),
    };
  }

  /** Called once per rendered frame with the newest snapshot. */
  
update(snapshot: RenderSnapshot, now: number): void {
    const healthPct = Math.max(0, Math.min(100, snapshot.playerHealth));
    this.healthFill.style.width = `${healthPct}%`;
    this.healthFill.dataset.low = healthPct <= 30 ? 'true' : 'false';
    this.healthText.textContent = String(Math.ceil(healthPct));

    this.ammoText.textContent = String(snapshot.ammo);
    this.reserveText.textContent = `/ ${snapshot.reserve}`;
    this.ammoText.dataset.empty = snapshot.ammo === 0 ? 'true' : 'false';

    const seconds = Math.ceil(snapshot.ticksRemaining / 60);
    const mm = Math.floor(seconds / 60);
    const ss = seconds % 60;
    this.timerText.textContent = `${mm}:${String(ss).padStart(2, '0')}`;

    this.scoreText.textContent = snapshot.score.toLocaleString();
    if (snapshot.streak > 1) {
      this.streakText.textContent = `${snapshot.streak} streak  x${snapshot.multiplier.toFixed(2)}`;
      this.streakText.dataset.visible = 'true';
    } else {
      this.streakText.dataset.visible = 'false';
    }

    // Down state gets an explicit notice; colour alone would not communicate it.
    if (snapshot.playerDownTicks > 0) {
      this.downNotice.dataset.visible = 'true';
      this.downNotice.textContent = `Respawning in ${Math.ceil(snapshot.playerDownTicks / 60)}`;
    } else {
      this.downNotice.dataset.visible = 'false';
    }

    this.hitMarker.dataset.visible = now < this.hitMarkerUntil ? 'true' : 'false';
    this.callout.dataset.visible = now < this.calloutUntil ? 'true' : 'false';

    // Damage indicator: the veil and the lit edge share a single expiry.
    const damaged = now < this.damageUntil;
    this.damageVeil.dataset.visible = damaged ? 'true' : 'false';
    for (const [edge, node] of Object.entries(this.damageEdges)) {
      node.dataset.visible = damaged && edge === this.damageEdge ? 'true' : 'false';
    }

    // Expire kill feed entries oldest first.
    while (this.feedEntries.length > 0 && this.feedEntries[0]!.until < now) {
      const entry = this.feedEntries.shift()!;
      entry.node.remove();
    }
  }

  /** Crosshair gap widens with accumulated spread, so the HUD shows what the weapon is doing. */
  setSpread(normalised: number): void {
    const gap = 4 + Math.max(0, Math.min(1, normalised)) * 26;
    this.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
  }

  /**
   * Record damage from a direction.
   *
   * `angleTurns` is the bearing to the attacker RELATIVE TO the player's facing, in turns: 0 is
   * directly ahead, 0.25 right, 0.5 behind, 0.75 left. Passed in rather than computed here because
   * the caller has the player's yaw from the snapshot and the attacker's position from the event,
   * and the HUD should not need to know either.
   */
  damageFrom(angleTurns: number, now: number): void {
    // Normalise to [0, 1) so a negative angle wraps around.
    const t = ((angleTurns % 1) + 1) % 1;
    this.damageEdge = t < 0.125 || t >= 0.875 ? 'front' : t < 0.375 ? 'right' : t < 0.625 ? 'back' : 'left';
    this.damageUntil = now + 260;
  }

  
handleEvents(events: readonly HudEvent[], now: number): void {
    for (const event of events) {
      switch (event.kind) {
        case 'hit':
          this.hitMarkerUntil = now + 90;
          this.hitMarker.dataset.head = 'false';
          break;
        case 'headshot':
          this.hitMarkerUntil = now + 140;
          this.hitMarker.dataset.head = 'true';
          break;
        case 'kill':
          this.pushFeed('Eliminated', now);
          break;
        case 'medal': {
          const name = event.medal !== undefined ? MEDAL_NAMES[event.medal] : undefined;
          if (name) {
            this.callout.textContent = name;
            this.calloutUntil = now + 1800;
          }
          break;
        }
        /*
         * 'damage' is no longer handled here. A direction needs the attacker's position and the
         * player's facing, neither of which this event carries; the caller routes it through
         * damageFrom instead, which is where the bearing is computed.
         */
        case 'dryFire':
          this.pushFeed('Empty: press R', now);
          break;
        case 'reloadStart':
          this.pushFeed('Reloading', now);
          break;
      }
    }
  }

  private pushFeed(text: string, now: number): void {
    const node = el('div', 'hud-killfeed-entry', this.killFeed);
    node.textContent = text;
    this.feedEntries.push({ node, until: now + 2600 });
    // Cap the feed so a busy wave cannot fill the screen.
    while (this.feedEntries.length > 5) {
      const entry = this.feedEntries.shift()!;
      entry.node.remove();
    }
  }

  dispose(): void {
    for (const entry of this.feedEntries) entry.node.remove();
    this.feedEntries.length = 0;
  }
}
