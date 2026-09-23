/**
 * Skydome.
 *
 * ## Why the arena needed one
 *
 * `clearColor` and `fogColor` were the same dark navy, so beyond the walls there was nothing: no horizon, no gradient, no sense
 * of being anywhere. The top edge of every wall met a flat colour identical to the fog, which reads as a rendering artefact.
 *
 * ## Three things that make a skydome go wrong, all of which it did
 *
 * **Size.** The diameter must clear the whole scene. Passing a value that leaves the dome near the geometry turns it from a
 * background into a room: an unlit shell a few units past the walls, which blacks the arena out. The arena is 48 units across, so
 * the dome is sized from that rather than from the draw distance.
 *
 * **Rendering group.** In the same group as the arena, depth sorting decides which wins per pixel and the dome intermittently
 * covers things nearer than its far side. It belongs in its own group, drawn first, with depth writes off so it can never
 * occlude.
 *
 * **Brightness.** A dome covers the entire upper hemisphere, so a colour that looks reasonable as a small swatch reads as black
 * across half the screen. Both gradient stops are lifted well above the clear colour they replaced.
 *
 * The horizon colour still matches the fog exactly. That is what lets distant geometry dissolve into the sky rather than fading to
 * one colour against another, which is the thing that reveals fog as a trick.
 */

import { GradientMaterial } from '@babylonjs/materials/gradient/gradientMaterial.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { QualityTier } from './quality.js';

/**
 * Colour overhead.
 *
 * Darker than the horizon, which is how a night sky reads: darkest directly above, not at the edges. Lifted well above the old
 * #05070c, which covered half the screen in near-black and made the whole scene look unlit.
 */
const ZENITH = '#10161f';

/**
 * Colour at the horizon.
 *
 * MUST match the tier fog colour (#121a26 in arena.ts). This is what lets distant geometry dissolve into the sky instead of
 * fading to a colour that sits in front of a different one.
 */
const HORIZON = '#121a26';

/**
 * Dome diameter, in world units.
 *
 * Sized from the ARENA (48 units across, 6-unit walls) rather than from the tier draw distance. 400 puts the shell far enough away
 * that it reads as sky at every tier, and a sphere is cheap regardless of radius: it is 16 segments and one unlit material.
 *
 * Sizing it from drawDistance was the original mistake. At Ultra that gave a 90-unit diameter, so the dome sat almost on the walls
 * and its unlit interior blacked out the arena.
 */
const DIAMETER = 400;

/**
 * Its own rendering group, drawn before everything else.
 *
 * Babylon renders groups in ascending order and clears depth between them, so the dome cannot occlude the arena regardless of
 * distance. In group 0 with the arena, depth sorting decided per pixel and geometry nearer than the dome's far side disappeared.
 */
const SKY_RENDER_GROUP = 0;
const SCENE_RENDER_GROUP = 1;

export interface Skydome {
  mesh: Mesh;
  applyTier(tier: QualityTier): void;
  dispose(): void;
}

/**
 * Build the dome. The tier parameter is kept in the signature so callers do not change if a tier-dependent property (segment
 * count, say) is added later; today nothing about the dome depends on it.
 */
export function buildSkydome(scene: Scene, _tier: QualityTier): Skydome {
  const material = new GradientMaterial('sky', scene);
  material.topColor = Color3.FromHexString(ZENITH);
  material.bottomColor = Color3.FromHexString(HORIZON);
  /*
   * Where the gradient sits. Above 0 pushes the transition upward, so the horizon band is wider than the zenith and the sky reads
   * as mostly dark with light at the edges.
   */
  material.offset = 0.25;
  // How abruptly the two colours meet. Low is a soft wash; high is a hard band that looks like a seam.
  material.smoothness = 1.2;
  material.scale = 0.1;
  /*
   * Unlit and not fogged. Fogging the sky would blend it toward the fog colour, which is already the horizon colour, flattening
   * the gradient into the single flat tone this exists to replace.
   */
  material.disableLighting = true;
  material.fogEnabled = false;
  // Rendered from inside, so the outward-facing normals have to be ignored.
  material.backFaceCulling = false;
  /*
   * No depth writes. Combined with the separate rendering group, this makes it impossible for the dome to hide geometry: it
   * contributes colour where nothing else has been drawn and nothing more.
   */
  material.disableDepthWrite = true;

  const mesh = MeshBuilder.CreateSphere('skydome', { diameter: DIAMETER, segments: 16 }, scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.checkCollisions = false;
  /*
   * Never parallaxes with the camera, so the sky cannot be walked toward and the dome cannot be escaped.
   */
  mesh.infiniteDistance = true;
  mesh.renderingGroupId = SKY_RENDER_GROUP;
  // Never a shadow caster or receiver: a 400-unit sphere in the shadow map would waste the entire resolution.
  mesh.receiveShadows = false;

  /*
   * Everything else moves to a later group, so the dome is always drawn first. Applied here rather than in arena.ts because it is
   * a consequence of the dome existing: without a sky there is no reason for the arena to be in group 1.
   */
  for (const other of scene.meshes) {
    if (other !== mesh) other.renderingGroupId = SCENE_RENDER_GROUP;
  }

  /*
   * New meshes default to group 0, which would put them behind the sky. Enemy figures, effects and decoration are all created
   * after this runs, so they need moving as they appear.
   */
  const onNewMesh = scene.onNewMeshAddedObservable.add((added) => {
    if (added !== mesh) added.renderingGroupId = SCENE_RENDER_GROUP;
  });

  return {
    mesh,

    applyTier(_next: QualityTier): void {
      /*
       * Nothing to do. The dome is sized from the arena rather than the draw distance, so a tier change does not affect it.
       *
       * The previous version rescaled from the mesh's current bounding radius, which compounded on every call: two tier changes
       * left the dome at a fraction of its intended size.
       */
    },

    dispose(): void {
      scene.onNewMeshAddedObservable.remove(onNewMesh);
      mesh.dispose();
      material.dispose();
    },
  };
}
