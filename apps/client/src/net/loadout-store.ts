/**
 * LoadoutStore: three saved equipment slots.
 *
 * ## Validation reports, it does not substitute
 *
 * When a slot references something the player has not unlocked, the store marks it stale and names the offending
 * choice. AC-ACC-CS-003.4 asks for the unavailable choice to be identified and replaced before use, and quietly
 * swapping in a default would be worse than an error: the player starts a round holding a weapon they did not
 * choose and only finds out when it fires differently.
 *
 * ## No unlocks means the starter set, not an empty set
 *
 * The `unlocks` table records what was earned, so a new player has no rows. Reading that strictly as "nothing is
 * available" would leave them unable to start a round at all, so the starter items below are always permitted.
 * They are the same two weapons the simulation's content declares, which is why the list is short and fixed.
 */

import { supabase } from './supabase.js';
import type { AuthSession } from './auth-session.js';

/** AC-ACC-CS-003.1: exactly three. */
export const LOADOUT_SLOTS = [1, 2, 3] as const;
export type LoadoutSlot = (typeof LOADOUT_SLOTS)[number];

/**
 * Items every player has without unlocking anything.
 *
 * Matches the weapons the client's SimContent declares. Keeping it here rather than deriving it from the weapon
 * table is deliberate: "available at level 1" is a progression decision, not a property of a weapon.
 */
const STARTER_WEAPONS = new Set(['rifle-01', 'pistol-01']);

export interface Loadout {
  slot: LoadoutSlot;
  name: string;
  primaryWeapon: string;
  secondaryWeapon: string;
  perks: string[];
}

/** A choice in a slot that the player cannot currently use. */
export interface StaleChoice {
  slot: LoadoutSlot;
  field: 'primaryWeapon' | 'secondaryWeapon' | 'perk';
  itemId: string;
}

export interface LoadoutState {
  loadouts: Loadout[];
  /** Item ids the player has unlocked, plus the starter set. */
  available: Set<string>;
  /** Choices that must be replaced before the slot can be used. */
  stale: StaleChoice[];
  loading: boolean;
  error: string | null;
}

function defaultLoadout(slot: LoadoutSlot): Loadout {
  return {
    slot,
    name: slot === 1 ? 'Default' : `Loadout ${slot}`,
    primaryWeapon: 'rifle-01',
    secondaryWeapon: 'pistol-01',
    perks: [],
  };
}

type Listener = (state: LoadoutState) => void;

export class LoadoutStore {
  private state: LoadoutState = {
    loadouts: LOADOUT_SLOTS.map(defaultLoadout),
    available: new Set(STARTER_WEAPONS),
    stale: [],
    loading: false,
    error: null,
  };
  private readonly listeners = new Set<Listener>();

  constructor(private readonly auth: AuthSession) {}

  getState(): LoadoutState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<LoadoutState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Load slots and unlocks. Falls back to defaults so a slot always exists to play with. */
  async load(): Promise<void> {
    const userId = this.auth.getState().userId;
    if (!supabase || !userId) {
      // Offline: defaults are playable, which is the point.
      this.set({ loadouts: LOADOUT_SLOTS.map(defaultLoadout), stale: [], error: null });
      return;
    }

    this.set({ loading: true, error: null });

    try {
      const [loadoutResult, unlockResult] = await Promise.all([
        supabase
          .from('loadouts')
          .select('slot, name, primary_weapon, secondary_weapon, perks')
          .eq('player_id', userId)
          .order('slot'),
        supabase.from('unlocks').select('item_id').eq('player_id', userId),
      ]);

      if (loadoutResult.error) throw loadoutResult.error;
      if (unlockResult.error) throw unlockResult.error;

      const available = new Set(STARTER_WEAPONS);
      for (const row of unlockResult.data ?? []) {
        available.add(row.item_id as string);
      }

      // Every slot must exist, so a missing row becomes a default rather than a gap in the UI.
      const bySlot = new Map<number, Loadout>();
      for (const row of loadoutResult.data ?? []) {
        const slot = row.slot as LoadoutSlot;
        bySlot.set(slot, {
          slot,
          name: (row.name as string) ?? `Loadout ${slot}`,
          primaryWeapon: row.primary_weapon as string,
          secondaryWeapon: row.secondary_weapon as string,
          perks: Array.isArray(row.perks) ? (row.perks as string[]) : [],
        });
      }
      const loadouts = LOADOUT_SLOTS.map((slot) => bySlot.get(slot) ?? defaultLoadout(slot));

      this.set({
        loadouts,
        available,
        stale: findStale(loadouts, available),
        loading: false,
        error: null,
      });
    } catch {
      /*
       * Clear to defaults, not just the flag. Leaving this.state.loadouts untouched meant a player who switched accounts and then
       * hit a network failure kept seeing the PREVIOUS account's loadouts, and the store reported them as usable.
       */
      this.set({
        loadouts: LOADOUT_SLOTS.map(defaultLoadout),
        stale: [],
        loading: false,
        error: 'Could not load loadouts. Using the ones saved on this device.',
      });
    }
  }

  /**
   * Save a slot.
   *
   * AC-ACC-CS-003.3: unlocked choices only. Rejected before the request rather than after, so an invalid loadout
   * never reaches the database and the error names the specific item.
   */
  async save(loadout: Loadout): Promise<{ ok: boolean; error?: string }> {
    const unavailable = [loadout.primaryWeapon, loadout.secondaryWeapon, ...loadout.perks].find(
      (item) => !this.state.available.has(item),
    );
    if (unavailable) {
      return { ok: false, error: `${unavailable} is not unlocked.` };
    }

    // Local first, as everywhere else: the change is visible immediately.
    const loadouts = this.state.loadouts.map((l) => (l.slot === loadout.slot ? loadout : l));
    this.set({ loadouts, stale: findStale(loadouts, this.state.available) });

    const userId = this.auth.getState().userId;
    if (!supabase || !userId) return { ok: true };

    try {
      const { error } = await supabase.from('loadouts').upsert(
        {
          player_id: userId,
          slot: loadout.slot,
          name: loadout.name,
          primary_weapon: loadout.primaryWeapon,
          secondary_weapon: loadout.secondaryWeapon,
          perks: loadout.perks,
        },
        { onConflict: 'player_id,slot' },
      );
      if (error) throw error;
      return { ok: true };
    } catch {
      // Saved locally, so this is a sync problem rather than a lost change.
      return { ok: false, error: 'Saved on this device. Could not reach the cloud.' };
    }
  }

  /** AC-ACC-CS-003.2: name a slot. */
  async rename(slot: LoadoutSlot, name: string): Promise<{ ok: boolean; error?: string }> {
    const existing = this.state.loadouts.find((l) => l.slot === slot);
    if (!existing) return { ok: false, error: 'No such slot.' };
    const trimmed = name.trim();
    if (trimmed === '') return { ok: false, error: 'Give the slot a name.' };
    return this.save({ ...existing, name: trimmed.slice(0, 24) });
  }

  /** True when this slot can start a round. */
  isUsable(slot: LoadoutSlot): boolean {
    return !this.state.stale.some((s) => s.slot === slot);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Every choice across every slot that is not currently available. */
function findStale(loadouts: readonly Loadout[], available: ReadonlySet<string>): StaleChoice[] {
  const stale: StaleChoice[] = [];
  for (const loadout of loadouts) {
    if (!available.has(loadout.primaryWeapon)) {
      stale.push({ slot: loadout.slot, field: 'primaryWeapon', itemId: loadout.primaryWeapon });
    }
    if (!available.has(loadout.secondaryWeapon)) {
      stale.push({ slot: loadout.slot, field: 'secondaryWeapon', itemId: loadout.secondaryWeapon });
    }
    for (const perk of loadout.perks) {
      if (!available.has(perk)) {
        stale.push({ slot: loadout.slot, field: 'perk', itemId: perk });
      }
    }
  }
  return stale;
}

/** Player-facing description of a stale choice. */
export function describeStale(stale: StaleChoice): string {
  const field =
    stale.field === 'primaryWeapon'
      ? 'primary weapon'
      : stale.field === 'secondaryWeapon'
        ? 'secondary weapon'
        : 'perk';
  return `Loadout ${stale.slot}: ${stale.itemId} is no longer available. Choose another ${field}.`;
}
