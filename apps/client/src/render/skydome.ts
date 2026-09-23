/**
 * Skydome.
 *
 * ## Why the arena needed one
 *
 * `clearColor` and `fogColor` were the same dark navy. Beyond the walls there was nothing: no horizon, no gradient, no sense of
 * being anywhere. The top edge of every wall met a flat colour identical to the fog, which reads as a rendering artefact rather
 * than as sky.
 *
 * One dome with a vertical gradient fixes it for a single draw call.
 *
 * ## The horizon colour matches the fog exactly
 *
 * This is the detail that makes it work. When the horizon and the fog are the same colour, distant geometry dissolves INTO the
 * sky; when they differ, fog is revealed as a grey wash sitting in front of a different colour, which looks like a bug. Any
 * change to the tier fog colour has to come with the same change here.
 *
 * ## Sizing
 *
 * The dome sits inside the far plane on every tier, including Low's 70 units. A dome clipped by the far plane leaves a hard
 * edge across the sky, which is worse than having no dome at all.
 */

import { GradientMaterial } from '@babylonjs/materials/gradient/gradientMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { QualityTier } from './quality.js';

/**
 * Colour at the top of the dome.
 *
 * Darker than the horizon, which is how a night sky actually reads: the darkest part is directly overhead, not at the edges.
 * Reversing this is the most common way a gradient sky looks wrong.
 */
const ZENITH = '#05070c';

/**
 * Colour at the horizon.
 *
 * MUST match the tier fog colour. See the note above: this is what lets distant geometry dissolve into the sky instead of
 * fading to a colour that sits in front of a different one.
 */
const HORIZON = '#121a26';

/**
 * A faint warm band just above the horizon, as if from lighting beyond the arena.
 *
 * Not physically motivated, but it gives the eye something to read as distance and suggests the arena sits inside a larger
 * facility rather than in empty space.
 */
const HAZE = '#1a2130';

export interface Skydome {
  mesh: Mesh;
  applyTier(tier: QualityTier): void;
  dispose(): void;
}

export function buildSkydome(scene: Scene, tier: QualityTier): Skydome {
  const material = new GradientMaterial('sky', scene);
  material.topColor = Color3.FromHexString(ZENITH);
  material.bottomColor = Color3.FromHexString(HORIZON);
  /*
   * Where the gradient sits. Above 0 pushes the transition upward, so the horizon band is wider than the zenith and the sky
   * reads as mostly dark with light at the edges.
   */
  material.offset = 0.18;
  // How abruptly the two colours meet. Low is a soft wash; high is a hard band that looks like a seam.
  material.smoothness = 1.4;
  material.scale = 0.1;
  /*
   * Unlit and not fogged. Fogging the sky would blend it toward the fog colour, which is already the horizon colour, flattening
   * the gradient into the single flat tone this exists to replace.
   */
  material.disableLighting = true;
  material.fogEnabled = false;
  // Rendered from inside, so the outward-facing normals have to be flipped.
  material.backFaceCulling = false;

  /*
   * Diameter is set from the draw distance so the dome is always inside the far plane. 1.6x the far plane would be clipped;
   * 0.9x leaves headroom on every tier including Low.
   */
  const mesh = MeshBuilder.CreateSphere(
    'skydome',
    { diameter: tier.drawDistance * 0.9, segments: 16 },
    scene,
  );
  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;
  /*
   * Never parallaxes with the camera, so the sky cannot be walked toward and the dome cannot be escaped. Without this a player
   * reaching a corner would see the dome's far side approaching.
   */
  mesh.infiniteDistance = true;
  // Behind everything. Without this the dome can occlude geometry that is nearer to the camera than its own far side.
  mesh.renderingGroupId = 0;

  /** A faint haze band, sitting just inside the dome near the horizon. */
  const hazeMaterial = new GradientMaterial('sky-haze', scene);
  hazeMaterial.topColor = Color3.FromHexString(HORIZON);
  hazeMaterial.bottomColor = Color3.FromHexString(HAZE);
  hazeMaterial.offset = 0.5;
  hazeMaterial.smoothness = 2;
  hazeMaterial.disableLighting = true;
  hazeMaterial.fogEnabled = false;
  hazeMaterial.backFaceCulling = false;
  hazeMaterial.alpha = 0.45;

  return {
    mesh,

    applyTier(next: QualityTier): void {
      /*
       * Resized rather than rebuilt: the draw distance changes with the tier, and a dome sized for Ultra's 200 units would be
       * clipped by Low's 70. Scaling is cheaper than disposing and recreating the mesh.
       */
      const target = next.drawDistance * 0.9;
      const current = mesh.getBoundingInfo().boundingSphere.radius * 2;
      if (current > 0) mesh.scaling.setAll(target / current);
    },

    dispose(): void {
      mesh.dispose();
      material.dispose();
      hazeMaterial.dispose();
    },
  };
}
