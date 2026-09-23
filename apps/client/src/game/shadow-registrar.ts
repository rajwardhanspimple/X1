/**
 * Shadow registrar.
 *
 * Keeps the shadow generator's caster list in step with the enemy pool.
 *
 * ## Why this exists as a module
 *
 * main used to do this with a boolean guard: register once on the first frame that produced any casters, then never again. That
 * is wrong in a way that is easy to miss, because the first wave looks correct. Every figure built afterwards casts nothing:
 * the pool grows when a wave is larger than the last, and it is rebuilt entirely when the quality tier changes or a glTF model
 * finishes loading. Those figures then hover, with no shadow anchoring them to the floor.
 *
 * Watching a generation counter fixes it without polling the mesh list. The renderer increments the counter whenever it builds
 * or destroys a figure, so the comparison here is one integer per frame and the real work only happens when the set changed.
 */

import type { EnemyRenderer } from '../render/enemies.js';

/** Meshes the renderer reports as shadow casters. Derived from the renderer so the two cannot disagree. */
type CasterList = ReturnType<EnemyRenderer['shadowCasters']>;

export interface ShadowRegistrar {
  /** Call once per frame. Registers only when the figure set has actually changed. */
  sync(): void;
}

/**
 * Watch an enemy renderer and re-register its casters when they change.
 *
 * `addCasters` is a plain callback rather than the arena itself, so this has no dependency on how shadows are configured; it only
 * needs somewhere to hand meshes.
 */
export function createShadowRegistrar(
  enemies: EnemyRenderer,
  addCasters: (meshes: CasterList) => void,
): ShadowRegistrar {
  // -1 rather than 0, so the first sync always registers even if nothing has been built yet.
  let lastGeneration = -1;

  return {
    sync(): void {
      const generation = enemies.generation();
      if (generation === lastGeneration) return;

      const casters = enemies.shadowCasters();
      /*
       * Nothing to register yet. The generation is deliberately NOT recorded, so the next frame tries again: on the first few
       * frames the pool is empty, and recording the generation here would mark that empty state as handled and never look
       * again.
       */
      if (casters.length === 0) return;

      lastGeneration = generation;
      addCasters(casters);
    },
  };
}
