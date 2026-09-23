/**
 * Visual mount: post-processing, decals, arena decoration and the skydome.
 *
 * All four belong together because they share one property: each reads the quality tier and nothing else, and nothing reads
 * them back. None has any relationship with the round lifecycle, the input pump, or the simulation.
 *
 * That is what makes one subscription to the quality store enough to drive all of them, and why main can mount the whole
 * presentation layer with a single call. The alternative, threading four things through main's applyTier, would mean four more
 * callers to keep in step across the probe, the settings menu, the battery saver and memory pressure.
 *
 * Same pattern as the account and sync mounts.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { buildDecor, type ArenaDecor } from '../render/decor.js';
import { DecalPool } from '../render/effects.js';
import { PostProcessing } from '../render/post.js';
import { buildSkydome, type Skydome } from '../render/skydome.js';
import type { QualityTierStore } from '../render/quality.js';

export interface VisualMount {
  /**
   * Mark a surface where a shot landed.
   *
   * `from` and `to` are the shot ray's endpoints, taken from the simulation's own event rather than recomputed on the client,
   * so a decal sits exactly where the bullet stopped.
   */
  markImpact(from: Vector3, to: Vector3, now: number): void;
  /** Per-frame work: decal fades and the beacon animation. */
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

  let decor: ArenaDecor = buildDecor(scene, quality.tier());
  let sky: Skydome = buildSkydome(scene, quality.tier());

  /*
   * Rebuilt on a tier change, like the other effect pools: the size is fixed at construction, so a tier allowing more decals
   * needs a new pool rather than a resized one.
   */
  let decals = new DecalPool(scene, quality.tier().decalPool);

  const apply = (): void => {
    const tier = quality.tier();

    post.apply(tier, quality.current().lowPowerMode);
    // Decor and sky adapt in place rather than rebuilding: both are cheap to reconfigure and expensive to recreate.
    decor.applyTier(tier);
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
       * Direction from the ray, normalised in place. The decal faces back along it, which approximates the surface normal well
       * enough for an axis-aligned arena: the true normal is known to the simulation's raycast but is not carried in the event,
       * and on a flat wall the difference is not visible.
       */
      direction.copyFrom(to).subtractInPlace(from);
      const length = direction.length();
      // A zero-length ray has no direction, and would produce a decal facing an arbitrary way.
      if (length < 0.01) return;
      direction.scaleInPlace(1 / length);

      /*
       * Pull back along the ray, out of the surface. Without this the plane is coplanar with the wall and z-fights regardless
       * of the depth offset on the material.
       */
      const at = to.subtract(direction.scale(0.01));
      decals.spawn(at, direction, now);
    },

    update(now: number): void {
      decals.update(now);
      // Passed the render loop's own timestamp rather than reading a clock, so nothing here drifts against the interpolator.
      decor.update(now);
    },

    setLoadFactor(factor: number): void {
      post.setLoadFactor(factor);
    },

    dispose(): void {
      unsubscribe();
      post.dispose();
      decals.dispose();
      decor.dispose();
      sky.dispose();
    },
  };
}
