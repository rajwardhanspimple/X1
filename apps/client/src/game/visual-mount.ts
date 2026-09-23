/**
 * Visual mount: post-processing and bullet decals.
 *
 * Both read the quality tier and nothing reads them back, which is what lets a single subscription to the quality store drive them and
 * keeps main from needing a branch for either. Same pattern as the account and sync mounts.
 *
 * Arena decoration used to be mounted here too. It has moved into arena.ts, because the arena is now built from containers that carry
 * their own colour and edges: decoration that exists to break up a flat wall has nothing left to do. The old module also hardcoded
 * arena dimensions that had drifted from the layout, so its wall detail sat several units inside the real walls.
 *
 * The rule that came out of that: anything positioned relative to arena geometry belongs in the file that reads the layout. Nothing
 * else should know how big the arena is.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { DecalPool } from '../render/effects.js';
import { PostProcessing } from '../render/post.js';
import { buildSkydome, type Skydome } from '../render/skydome.js';
import type { QualityTierStore } from '../render/quality.js';

export interface VisualMount {
  /**
   * Mark a surface where a shot landed.
   *
   * `from` and `to` are the shot ray's endpoints, taken from the simulation's own event rather than recomputed on the client, so a
   * decal sits exactly where the bullet stopped.
   */
  markImpact(from: Vector3, to: Vector3, now: number): void;
  /** Per-frame work: decal fades. */
  update(now: number): void;
  /** Reduce optional passes when the frame budget is tight. */
  setLoadFactor(factor: number): void;
  dispose(): void;
}

/** Scratch vector, reused so a shot does not allocate. At 500 rounds per minute that matters. */
const direction = new Vector3();

export function mountVisuals(
  scene: Scene,
  camera: Camera,
  quality: QualityTierStore,
): VisualMount {
  const post = new PostProcessing(scene, camera);
  const sky: Skydome = buildSkydome(scene, quality.tier());

  /*
   * Rebuilt on a tier change, like the other effect pools: the size is fixed at construction, so a tier allowing more decals needs a
   * new pool rather than a resized one.
   */
  let decals = new DecalPool(scene, quality.tier().decalPool);

  const apply = (): void => {
    const tier = quality.tier();

    post.apply(tier, quality.current().lowPowerMode);
    sky.applyTier(tier);

    decals.dispose();
    decals = new DecalPool(scene, tier.decalPool);
  };

  apply();

  // Follows the tier from wherever it changed: probe, settings menu, battery saver or memory pressure.
  const unsubscribe = quality.onChange(apply);

  return {
    markImpact(from: Vector3, to: Vector3, now: number): void {
      /*
       * Direction from the ray, normalised in place. The decal faces back along it, which approximates the surface normal well enough
       * for an axis-aligned yard: the true normal is known to the simulation's raycast but is not carried in the event, and on a flat
       * container side the difference is not visible.
       */
      direction.copyFrom(to).subtractInPlace(from);
      const length = direction.length();
      // A zero-length ray has no direction, and would produce a decal facing an arbitrary way.
      if (length < 0.01) return;
      direction.scaleInPlace(1 / length);

      /*
       * Pull back along the ray, out of the surface. Without this the plane is coplanar with the container and z-fights regardless of
       * the depth offset on the material.
       */
      const at = to.subtract(direction.scale(0.01));
      decals.spawn(at, direction, now);
    },

    update(now: number): void {
      decals.update(now);
    },

    setLoadFactor(factor: number): void {
      post.setLoadFactor(factor);
    },

    dispose(): void {
      unsubscribe();
      post.dispose();
      decals.dispose();
      sky.dispose();
    },
  };
}
