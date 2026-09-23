/**
 * Visual mount: post-processing and bullet decals.
 *
 * Self-mounting, like the account and sync surfaces. The module builds its own pieces, follows tier changes, and disposes
 * itself; main needs one call and one disposal.
 *
 * That is not only to keep the diff small. Neither post-processing nor decals has any relationship with the round lifecycle,
 * the input pump, or the simulation. Threading them through main's applyTier would couple subsystems that otherwise never
 * interact, and applyTier already has four callers (the probe, a manual choice, the battery saver, memory pressure) that would
 * each need to know about a fifth thing.
 *
 * Taking the quality STORE rather than a tier value is what makes that work: the mount subscribes, so the pipeline follows the
 * tier wherever the change originated.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { DecalPool } from '../render/effects.js';
import { PostProcessing } from '../render/post.js';
import type { QualityTierStore } from '../render/quality.js';

export interface VisualMount {
  /**
   * Mark a surface where a shot landed.
   *
   * `from` and `to` are the shot ray's endpoints, which come from the simulation's own event rather than a client-side
   * recomputation, so a decal sits exactly where the bullet stopped.
   */
  markImpact(from: Vector3, to: Vector3, now: number): void;
  /** Advance decal fades. Called once per frame. */
  update(now: number): void;
  /** Reduce optional passes when the frame budget is tight. */
  setLoadFactor(factor: number): void;
  dispose(): void;
}

/** Scratch vector, reused so a shot does not allocate. At 500 rounds per minute that adds up. */
const direction = new Vector3();

export function mountVisuals(
  scene: Scene,
  camera: Camera,
  quality: QualityTierStore,
): VisualMount {
  const post = new PostProcessing(scene, camera);

  /*
   * Rebuilt on a tier change, like the other pools: the size is fixed at construction so a tier that allows more decals needs
   * a new pool rather than a resized one.
   */
  let decals = new DecalPool(scene, quality.tier().decalPool);

  const apply = (): void => {
    const tier = quality.tier();
    post.apply(tier, quality.current().lowPowerMode);

    decals.dispose();
    decals = new DecalPool(scene, tier.decalPool);
  };

  apply();

  // Follows the tier from wherever it changed: probe, menu, battery saver or memory pressure.
  const unsubscribe = quality.onChange(apply);

  return {
    markImpact(from: Vector3, to: Vector3, now: number): void {
      /*
       * Direction from the ray, normalised in place. The decal faces back along it, which is a good approximation of the
       * surface normal for an axis-aligned arena: the true normal is known to the simulation's raycast but is not carried in
       * the event, and the difference is not visible on flat walls.
       */
      direction.copyFrom(to).subtractInPlace(from);
      const length = direction.length();
      // A zero-length ray has no direction to orient against, and would produce a decal facing an arbitrary way.
      if (length < 0.01) return;
      direction.scaleInPlace(1 / length);

      /*
       * Pull the decal slightly back along the ray, out of the surface it hit. Without this the plane is coplanar with the
       * wall and z-fights regardless of the depth offset on the material.
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
    },
  };
}
