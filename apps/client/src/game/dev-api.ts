/**
 * Developer console API.
 *
 * Exposed as `window.rearena` in development builds only. `import.meta.env.DEV` is a compile-time
 * constant, so this whole module is removed from a production bundle by dead-code elimination rather
 * than merely being hidden behind a runtime check.
 *
 * Why these exist as a worker command rather than something you can poke from the console directly:
 * gameplay state lives in SimState inside the simulation worker, and the main thread only ever
 * receives read-only snapshots of it. There is no message that writes health or ammo, because that
 * message is precisely what a cheat client would use. Adding a dev path means adding it explicitly,
 * behind a flag that marks the run unverifiable.
 *
 * Any use of these taints the round. That is not a policy choice, it is arithmetic: the overrides are
 * applied after the simulation steps, so the state hashes no longer match a clean replay of the same
 * inputs, and the verifier would reject the run. Marking it locally means the player is told rather
 * than having a submission fail silently later.
 */

import type { DebugAction, DebugFlags } from '../worker/protocol.js';

export interface DevApiTarget {
  setDebugFlags(flags: Partial<DebugFlags>): void;
  runDebugAction(action: DebugAction): void;
  currentFlags(): DebugFlags;
  isTainted(): boolean;
  snapshotSummary(): Record<string, unknown>;
}

/** Shape exposed on window. Kept small: this is a playtest aid, not a scripting surface. */
export interface DevApi {
  /** Health is restored every tick. Pass false to turn it off. */
  godMode(on?: boolean): string;
  /** Magazine and reserve refilled every tick. Pass false to turn it off. */
  infiniteAmmo(on?: boolean): string;
  /** Kill every living enemy. */
  clearWave(): string;
  /** Jump to a later wave, to reach late-game pressure without waiting. */
  setWave(wave: number): string;
  /** End the round now, to reach the results screen. */
  endRound(): string;
  /** Current player and round state, for inspection. */
  state(): Record<string, unknown>;
  /** What is available. */
  help(): string;
}

const HELP = `RE:Arena developer console

  rearena.godMode()          health restored every tick
  rearena.godMode(false)     turn it off
  rearena.infiniteAmmo()     magazine refilled every tick
  rearena.clearWave()        kill every living enemy
  rearena.setWave(8)         jump to wave 8
  rearena.endRound()         end now and show results
  rearena.state()            inspect player and round state

Any of these marks the run unverifiable: the overrides are applied outside the
simulation, so its state hashes no longer match a replay of the same inputs.
Start a new round for a clean one.`;

export function installDevApi(target: DevApiTarget): () => void {
  if (!import.meta.env.DEV) return () => {};

  const taintNote = (what: string): string =>
    `${what}. Run is now unverifiable; start a new round for a clean one.`;

  const api: DevApi = {
    godMode(on = true) {
      target.setDebugFlags({ invincible: on });
      return on ? taintNote('God mode on') : 'God mode off (run stays unverifiable)';
    },
    infiniteAmmo(on = true) {
      target.setDebugFlags({ infiniteAmmo: on });
      return on ? taintNote('Infinite ammo on') : 'Infinite ammo off (run stays unverifiable)';
    },
    clearWave() {
      target.runDebugAction({ kind: 'clearWave' });
      return taintNote('Wave cleared');
    },
    setWave(wave: number) {
      if (!Number.isFinite(wave) || wave < 0) return 'Pass a wave number, e.g. rearena.setWave(8)';
      target.runDebugAction({ kind: 'setWave', wave });
      return taintNote(`Jumped to wave ${Math.floor(wave)}`);
    },
    endRound() {
      target.runDebugAction({ kind: 'endRound' });
      return taintNote('Round ended');
    },
    state() {
      return { ...target.snapshotSummary(), flags: target.currentFlags(), tainted: target.isTainted() };
    },
    help() {
      return HELP;
    },
  };

  (window as unknown as { rearena: DevApi }).rearena = api;
  console.info('[rearena] developer console available: rearena.help()');

  return () => {
    delete (window as unknown as { rearena?: DevApi }).rearena;
  };
}
</content>