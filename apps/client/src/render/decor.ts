/**
 * Arena decoration.
 *
 * ## Nothing here is solid
 *
 * This is the constraint that shapes every decision in this file. `layout.ts` in the sim package is the single source of truth
 * for collision, and the verifier replays a run against exactly those boxes. A decorative mesh that blocked a bullet would
 * either desynchronise a verified run or have to become part of the layout, so every mesh built here is `isPickable = false`,
 * `checkCollisions = false`, and sits flush against or above existing geometry rather than protruding into playable space.
 *
 * Cover the player can see but bullets pass through is the specific failure to avoid, and the way to avoid it is to never put
 * decoration where a player could mistake it for cover.
 *
 * ## Why per-side colour
 *
 * The arena is perfectly symmetric. That is right for fairness and wrong for orientation: every corner looks the same, so a
 * player who spins around cannot tell which way they are facing. Four accent colours on the four walls solve it for the cost
 * of four materials, and they double as a way to describe positions ("push blue side").
 *
 * ## Why a beacon
 *
 * One strong landmark, above the centre platform, visible from anywhere. It is also the only thing in the scene that moves on
 * its own, which is what makes it read as a landmark rather than as another box.
 *
 * ## Why geometry rather than textures
 *
 * Panel seams and trims are thin quads, not a texture. The KTX2 pipeline arrives with WO-7, and a flat wall now is worth more
 * than a detailed wall later; a handful of unlit quads costs almost nothing and separates surfaces immediately.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { QualityTier } from './quality.js';

/**
 * Accent colour per compass side.
 *
 * Chosen to be distinguishable from each other AND from the enemy archetype colours (#e0644f red, #e0a94f amber, #b44fe0
 * purple). A wall accent that matched an enemy tint would make a distant figure hard to pick out against it, which trades a
 * navigation gain for a readability loss.
 */
export const SIDE_ACCENTS = {
  north: '#4f8ce0', // blue
  south: '#4fe0a9', // teal
  east: '#e0d24f', // yellow
  west: '#9d4fe0', // violet
} as const;

export type SideName = keyof typeof SIDE_ACCENTS;

/** Arena half-extent, matching ARENA_HALF in the sim layout. */
const HALF = 24;
const WALL_HEIGHT = 6;

export interface ArenaDecor {
  root: TransformNode;
  /** Meshes that should receive shadows. Decoration never casts: it is flush with what it decorates. */
  receivers: Mesh[];
  /** Animate the beacon. Called once per frame with elapsed seconds. */
  update(now: number): void;
  applyTier(tier: QualityTier): void;
  dispose(): void;
}

/** Unlit emissive material for an accent strip. */
function accentMaterial(scene: Scene, name: string, hex: string, strength: number): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  /*
   * Emissive above 1 so bloom's threshold catches it. The threshold sits above ordinary lit geometry, so an accent at 1.0
   * would not glow at all and the strips would look like paint.
   */
  material.emissiveColor = colour.scale(strength);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.disableLighting = true;
  return material;
}

/** Dark material for panel seams and trims. */
function seamMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.FromHexString(hex);
  material.specularColor = new Color3(0.06, 0.06, 0.08);
  material.specularPower = 24;
  return material;
}

export function buildDecor(scene: Scene, tier: QualityTier): ArenaDecor {
  const root = new TransformNode('decor', scene);
  const receivers: Mesh[] = [];
  const materials: StandardMaterial[] = [];
  const meshes: Mesh[] = [];

  /** Register a decorative mesh. Never solid, never a shadow caster, never pickable. */
  const decorate = (mesh: Mesh, material: StandardMaterial): void => {
    mesh.parent = root;
    mesh.material = material;
    // The three properties that keep decoration out of gameplay.
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.doNotSyncBoundingInfo = true;
    meshes.push(mesh);
  };

  const trim = seamMaterial(scene, 'decor-trim', '#151920');
  const panel = seamMaterial(scene, 'decor-panel', '#1b2029');
  materials.push(trim, panel);

  // --- Wall accents and panels -------------------------------------------------------------------
  //
  // One horizontal strip per wall at eye height, plus vertical seams breaking the span into panels. The strip is the
  // navigation cue; the seams stop a 48-unit wall reading as one flat surface.

  const sides: Array<{ side: SideName; x: number; z: number; rotY: number; span: number }> = [
    { side: 'north', x: 0, z: HALF - 0.52, rotY: Math.PI, span: HALF * 2 },
    { side: 'south', x: 0, z: -(HALF - 0.52), rotY: 0, span: HALF * 2 },
    { side: 'east', x: HALF - 0.52, z: 0, rotY: -Math.PI / 2, span: HALF * 2 },
    { side: 'west', x: -(HALF - 0.52), z: 0, rotY: Math.PI / 2, span: HALF * 2 },
  ];

  for (const { side, x, z, rotY, span } of sides) {
    const accent = accentMaterial(scene, `decor-accent-${side}`, SIDE_ACCENTS[side], 1.8);
    materials.push(accent);

    /*
     * The strip sits at 2.4 units: above a crouching player's eye line and below standing head height, so it is visible
     * across the arena without being something a player tries to shelter behind.
     */
    const strip = MeshBuilder.CreatePlane(
      `decor-strip-${side}`,
      { width: span - 2, height: 0.14 },
      scene,
    );
    strip.position.set(x, 2.4, z);
    strip.rotation.y = rotY;
    decorate(strip, accent);

    // A second, dimmer strip near the floor. Reads as spill from the first and grounds the wall.
    const floorGlow = MeshBuilder.CreatePlane(
      `decor-glow-${side}`,
      { width: span - 2, height: 0.06 },
      scene,
    );
    floorGlow.position.set(x, 0.18, z);
    floorGlow.rotation.y = rotY;
    const dim = accentMaterial(scene, `decor-glow-mat-${side}`, SIDE_ACCENTS[side], 0.7);
    materials.push(dim);
    decorate(floorGlow, dim);

    // Vertical seams every 8 units, which is roughly one panel per two cover boxes.
    const seamCount = Math.floor(span / 8);
    for (let i = 1; i < seamCount; i++) {
      const offset = -span / 2 + (span / seamCount) * i;
      const seam = MeshBuilder.CreatePlane(
        `decor-seam-${side}-${i}`,
        { width: 0.1, height: WALL_HEIGHT - 0.4 },
        scene,
      );
      // Rotate the offset into the wall's own axis, so one loop handles all four orientations.
      const sin = Math.sin(rotY);
      const cos = Math.cos(rotY);
      seam.position.set(x + offset * cos, WALL_HEIGHT / 2 - 0.2, z - offset * sin);
      seam.rotation.y = rotY;
      decorate(seam, panel);
    }

    // Top trim: a thin band capping the wall, which gives it a finished edge rather than a cut-off.
    const cap = MeshBuilder.CreateBox(
      `decor-cap-${side}`,
      side === 'north' || side === 'south'
        ? { width: span, height: 0.18, depth: 1.2 }
        : { width: 1.2, height: 0.18, depth: span },
      scene,
    );
    cap.position.set(
      side === 'east' ? HALF : side === 'west' ? -HALF : 0,
      WALL_HEIGHT - 0.09,
      side === 'north' ? HALF : side === 'south' ? -HALF : 0,
    );
    decorate(cap, trim);
  }

  // --- Floor markings ---------------------------------------------------------------------------
  //
  // A ring around the centre platform and four lane lines toward the pillars. Painted on the floor, so they orient a player
  // looking down without adding anything to trip over.

  const paint = accentMaterial(scene, 'decor-paint', '#2a3242', 1);
  materials.push(paint);

  const ring = MeshBuilder.CreateTorus(
    'decor-ring',
    { diameter: 11, thickness: 0.12, tessellation: 48 },
    scene,
  );
  // Just above the floor: coplanar would z-fight, and higher would be a visible lip.
  ring.position.set(0, 0.02, 0);
  decorate(ring, paint);

  for (const { side, x, z } of sides) {
    const lane = MeshBuilder.CreatePlane(`decor-lane-${side}`, { width: 0.16, height: 12 }, scene);
    // Flat on the floor: a plane defaults to vertical, so it needs the quarter turn.
    lane.rotation.x = Math.PI / 2;
    lane.position.set(x * 0.55, 0.02, z * 0.55);
    if (side === 'east' || side === 'west') lane.rotation.z = Math.PI / 2;
    const laneMat = accentMaterial(scene, `decor-lane-mat-${side}`, SIDE_ACCENTS[side], 0.5);
    materials.push(laneMat);
    decorate(lane, laneMat);
  }

  // --- Central beacon ---------------------------------------------------------------------------
  //
  // The landmark. Suspended above the centre platform, so it is visible from every corner and from behind cover, and it is the
  // only thing in the scene that moves on its own.

  const beaconRoot = new TransformNode('decor-beacon', scene);
  beaconRoot.parent = root;
  // Above the 1.8-unit centre platform, high enough that no figure occludes it from across the arena.
  beaconRoot.position.set(0, 4.6, 0);

  const beaconCore = accentMaterial(scene, 'decor-beacon-core', '#e0a94f', 2.6);
  materials.push(beaconCore);

  const core = MeshBuilder.CreateIcoSphere('decor-beacon-core-mesh', { radius: 0.42, subdivisions: 2 }, scene);
  decorate(core, beaconCore);
  core.parent = beaconRoot;

  // Two counter-rotating rings. Motion is what distinguishes a landmark from scenery.
  const ringA = MeshBuilder.CreateTorus(
    'decor-beacon-ring-a',
    { diameter: 1.5, thickness: 0.06, tessellation: 32 },
    scene,
  );
  decorate(ringA, beaconCore);
  ringA.parent = beaconRoot;

  const ringB = MeshBuilder.CreateTorus(
    'decor-beacon-ring-b',
    { diameter: 1.9, thickness: 0.05, tessellation: 32 },
    scene,
  );
  ringB.rotation.x = Math.PI / 2;
  decorate(ringB, beaconCore);
  ringB.parent = beaconRoot;

  // A mast connecting the beacon to the platform, so it reads as installed rather than floating.
  const mast = MeshBuilder.CreateCylinder(
    'decor-beacon-mast',
    { diameter: 0.14, height: 3.6, tessellation: 8 },
    scene,
  );
  mast.position.set(0, 2.9, 0);
  decorate(mast, trim);

  let beaconVisible = true;

  return {
    root,
    receivers,

    update(now: number): void {
      if (!beaconVisible) return;
      const seconds = now / 1000;
      // Slow and counter-rotating: fast spin would draw the eye away from enemies, which is a gameplay cost.
      ringA.rotation.y = seconds * 0.5;
      ringB.rotation.z = -seconds * 0.35;
      // A gentle bob, so the beacon is alive even when the player is standing still.
      beaconRoot.position.y = 4.6 + Math.sin(seconds * 0.8) * 0.12;
    },

    applyTier(next: QualityTier): void {
      /*
       * Decoration is cheap but not free: on Low every one of these is an extra draw call competing with the figures that
       * actually matter. The accents stay (they are the navigation cue and the cheapest thing here) and the beacon goes, since
       * it is the only animated node.
       */
      const detailed = next.name !== 'low';
      beaconVisible = detailed;
      beaconRoot.setEnabled(detailed);
      mast.setEnabled(detailed);
      ring.setEnabled(detailed);

      for (const mesh of meshes) {
        if (mesh.name.startsWith('decor-seam-') || mesh.name.startsWith('decor-lane-')) {
          mesh.setEnabled(detailed);
        }
      }
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      meshes.length = 0;
      for (const material of materials) material.dispose();
      materials.length = 0;
      beaconRoot.dispose();
      root.dispose();
    },
  };
}
