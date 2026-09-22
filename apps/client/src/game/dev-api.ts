/**
 * Developer console API.
 *
 * Exposed as `window.rearena` in development builds only. `import.meta.env.DEV` is a compile-time constant,
 * so this whole module is removed from a production bundle by dead-code elimination rather than merely
 * being hidden behind a runtime check.
 *
 * Why the gameplay overrides exist as a worker command rather than something you can poke from the console
 * directly: gameplay state lives in SimState inside the simulation worker, and the main thread only ever
 * receives read-only snapshots of it. There is no message that writes health or ammo, because that message
 * is precisely what a cheat client would use. Adding a dev path means adding it explicitly, behind a flag
 * that marks the run unverifiable.
 *
 * Note the distinction: godMode and friends taint the run, because the overrides are applied after the
 * simulation steps and its state hashes no longer match a clean replay. Choosing or inspecting a character
 * model does not, because rendering has no effect on the simulation at all.
 */

import { selectedModelId, setSelectedModelId } from '../render/character-loader.js';
import { capabilitySummary, MODEL_OPTIONS } from '../render/model-catalogue.js';
import {
  formatClipList,
  formatProbeResults,
  probeAllModels,
  probeModel,
} from '../render/model-probe.js';
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
  /** List models with their measured capabilities, or switch to one by id and reload. */
  model(id?: string): string;
  /** Re-measure every model URL: reachable, animated, and which poses it has. */
  testModels(): Promise<string>;
  /** Dump one model's animation clip names. */
  clips(id: string): Promise<string>;
  /** Current player and round state, for inspection. */
  state(): Record<string, unknown>;
  /** What is available. */
  help(): string;
}

const HELP = `RE:Arena developer console

  rearena.model()            list models and what each can do
  rearena.model('swat')      switch model and reload
  rearena.clips('swat')      list one model's animation clip names
  rearena.testModels()       re-measure every model from the network

  rearena.godMode()          health restored every tick
  rearena.godMode(false)     turn it off
  rearena.infiniteAmmo()     magazine refilled every tick
  rearena.clearWave()        kill every living enemy
  rearena.setWave(8)         jump to wave 8
  rearena.endRound()         end now and show results
  rearena.state()            inspect player and round state

The gameplay overrides mark the run unverifiable: they are applied outside the
simulation, so its state hashes no longer match a replay of the same inputs.
Choosing or inspecting a model does not, since rendering cannot affect the simulation.`;

/** Group heading for a model, by what its clips support. */
function tier(id: string): string {
  const option = MODEL_OPTIONS.find((m) => m.id === id);
  const caps = option?.capabilities;
  if (!caps) return 'Local';
  if (caps.weapon && caps.directional) return 'Complete: weapon poses, strafes, reactions';
  if (caps.weapon) return 'Weapon poses and reactions, no strafes';
  if (caps.reactions) return 'Movement and reactions, no weapon poses';
  return 'Movement only';
}

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
    model(id?: string) {
      const current = selectedModelId();

      if (!id) {
        /*
         * Grouped by capability rather than listed flat. Which model has weapon poses is the question that
         * decides the choice, so it leads; triangle count is secondary and clip count is detail.
         */
        const lines: string[] = [];
        let lastTier = '';
        for (const m of MODEL_OPTIONS) {
          const t = tier(m.id);
          if (t !== lastTier) {
            lines.push('', `  ${t}`);
            lastTier = t;
          }
          const marker = m.id === current ? '>' : ' ';
          lines.push(
            `${marker} ${m.id.padEnd(20)} ${m.triangles.padEnd(7)} ${capabilitySummary(m).padEnd(28)} ${m.label}`,
          );
        }

        return [
          'Character models (> = current). Measured in the browser, not taken from listings.',
          ...lines,
          '',
          "Switch with rearena.model('cube-guy'). Clip names with rearena.clips('swat').",
        ].join('\n');
      }

      if (!setSelectedModelId(id)) {
        const ids = MODEL_OPTIONS.map((m) => m.id).join(', ');
        return `Unknown model "${id}". Available: ${ids}`;
      }

      /*
       * Reload rather than hot-swapping. The template is instanced into every live figure, so replacing it
       * means rebuilding all of them mid-round; a reload is simpler, and on a dev server it is effectively
       * instant.
       */
      setTimeout(() => window.location.reload(), 120);
      return `Switched to "${id}". Reloading.`;
    },
    async testModels() {
      const results = await probeAllModels();
      const text = formatProbeResults(results);
      // Logged as well as returned: the console truncates long return values but not log output.
      console.info(text);
      return text;
    },
    async clips(id: string) {
      const result = await probeModel(id);
      if (!result) {
        const ids = MODEL_OPTIONS.map((m) => m.id).join(', ');
        return `Unknown model "${id}". Available: ${ids}`;
      }
      const text = formatClipList(result);
      console.info(text);
      return text;
    },
    state() {
      return {
        ...target.snapshotSummary(),
        model: selectedModelId(),
        flags: target.currentFlags(),
        tainted: target.isTainted(),
      };
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
