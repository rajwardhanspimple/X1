/**
 * Arena decoration: structure, not lighting.
 *
 * ## Nothing here is solid
 *
 * This is the constraint that shapes every decision in this file. `layout.ts` in the sim package is the single source of truth for
 * collision, and the verifier replays a run against exactly those boxes. A decorative mesh that blocked a bullet would either
 * desynchronise a verified run or have to become part of the layout, so every mesh built here is `isPickable = false`,
 * `checkCollisions = false`, and sits flush against or above existing geometry rather than protruding into playable space.
 *
 * Cover the player can see but bullets pass through is the specific failure to avoid.
 *
 * ## Why there are no light strips here
 *
 * There were, and they were a mistake twice over.
 *
 * First the values: accents at 1.8 emissive against arena surfaces at 14% grey made the decoration the brightest thing on screen, so
 * the arena looked like glowing lines in a void. Then, once the arena was lit properly, the real problem showed: `arena.ts` ALREADY
 * drew a strip near the top of each wall, and this file was adding two more at eye height and floor level. Three glowing lines per
 * wall at three heights, crossing each other and the wall edges in perspective, reading as a rendering fault.
 *
 * The per-side colour was the good idea, so it moved onto the strip that already existed. This file now draws structure only, and
 * the one thing here that emits is the beacon, which is supposed to draw the eye.
 *
 * The rule worth carrying forward: exactly one source per job, and check what already exists before adding another.
 *
 * ## Why per-side colour (applied in arena.ts, defined here)
 *
 * The arena is perfectly symmetric. That is right for fairness and wrong for orientation: every corner looks the same, so a player
 * who spins around cannot tell which way they are facing. Four accent colours on the four walls solve it, and they double as a way
 * to describe positions ("push blue side").
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { QualityTier } from './quality.js';

/**
 * Accent colour per compass side. Consumed by arena.ts for the wall strips.
 *
 * Chosen to be distinguishable from each other AND from the enemy archetype colours (#e0644f red, #e0a94f amber, #b44fe0 purple).
 * A wall accent matching an enemy tint would make a distant figure hard to pick out against it, trading a navigation gain for a
 * readability loss.
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
  /** Animate the beacon. Called once per frame with elapsed milliseconds. */
  update(now: number): void;
  applyTier(tier: QualityTier): void;
  dispose(): void;
}

/** Lit material for structural detail. Seams and trims are geometry, so they take light like geometry. */
function structureMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  material.diffuseColor = colour;
  material.specularColor = new Color3(0.14, 0.15, 0.17);
  material.specularPower = 28;
  material.ambientColor = colour.scale(0.85);
  return material;
}

export function buildDecor(scene: Scene, tier: QualityTier): ArenaDecor {
  const root = new TransformNode('decor', scene);
  const materials: StandardMaterial[] = [];
  const meshes: Mesh[] = [];

  /** Register a decorative mesh. Never solid, never pickable. */
  const decorate = (mesh: Mesh, material: StandardMaterial): void => {
    mesh.parent = root;
    mesh.material = material;
    // The two properties that keep decoration out of gameplay.
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    meshes.push(mesh);
  };

  /*
   * Darker than the walls they sit on, so a seam reads as a recess. Mid grey rather than near-black: at 14% a seam looked like a gap
   * in the geometry rather than a join in it.
   */
  const trim = structureMaterial(scene, 'decor-trim', '#4f5766');
  const panel = structureMaterial(scene, 'decor-panel', '#5a6373');
  materials.push(trim, panel);

  // --- Wall panels and trims --------------------------------------------------------------------
  //
  // Vertical seams break a 48-unit wall into panels, and a top trim caps it. Both are structure: they change the silhouette without
  // adding anything that glows.

  const sides: Array<{ side: SideName; x: number; z: number; rotY: number; span: number }> = [
    { side: 'north', x: 0, z: HALF - 0.52, rotY: Math.PI, span: HALF * 2 },
    { side: 'south', x: 0, z: -(HALF - 0.52), rotY: 0, span: HALF * 2 },
    { side: 'east', x: HALF - 0.52, z: 0, rotY: -Math.PI / 2, span: HALF * 2 },
    { side: 'west', x: -(HALF - 0.52), z: 0, rotY: Math.PI / 2, span: HALF * 2 },
  ];

  for (const { side, x, z, rotY, span } of sides) {
    // Seams every 8 units, roughly one panel per two cover boxes.
    const seamCount = Math.floor(span / 8);
    for (let i = 1; i < seamCount; i++) {
      const offset = -span / 2 + (span / seamCount) * i;
      const seam = MeshBuilder.CreatePlane(
        `decor-seam-${side}-${i}`,
        { width: 0.12, height: WALL_HEIGHT - 0.6 },
        scene,
      );
      // Rotate the offset into the wall's own axis, so one loop handles all four orientations.
      const sin = Math.sin(rotY);
      const cos = Math.cos(rotY);
      seam.position.set(x + offset * cos, WALL_HEIGHT / 2 - 0.3, z - offset * sin);
      seam.rotation.y = rotY;
      decorate(seam, panel);
    }

    // Top trim: a band capping the wall, so it has a finished edge rather than a cut-off.
    const cap = MeshBuilder.CreateBox(
      `decor-cap-${side}`,
      side === 'north' || side === 'south'
        ? { width: span, height: 0.2, depth: 1.3 }
        : { width: 1.3, height: 0.2, depth: span },
      scene,
    );
    cap.position.set(
      side === 'east' ? HALF : side === 'west' ? -HALF : 0,
      WALL_HEIGHT - 0.1,
      side === 'north' ? HALF : side === 'south' ? -HALF : 0,
    );
    decorate(cap, trim);
  }

  // --- Floor marking ----------------------------------------------------------------------------
  //
  // A ring around the centre platform, painted rather than emissive. It marks something real, which is the test decoration has to
  // pass. The lane lines that used to run from here to the pillars are gone: they were unlit emissive planes lying flat on the floor,
  // they read as bright wires crossing the arena, and they marked nothing a player needed to know.

  const paint = structureMaterial(scene, 'decor-paint', '#9aa6bd');
  materials.push(paint);

  const ring = MeshBuilder.CreateTorus(
    'decor-ring',
    { diameter: 11, thickness: 0.1, tessellation: 40 },
    scene,
  );
  // Just above the floor: coplanar would z-fight, higher would be a visible lip.
  ring.position.set(0, 0.02, 0);
  decorate(ring, paint);

  // --- Central beacon ---------------------------------------------------------------------------
  //
  // The landmark, and the only thing in this file that emits. Above the centre platform, visible from every corner and from behind
  // cover, and the only thing in the scene that moves on its own.

  const beaconRoot = new TransformNode('decor-beacon', scene);
  beaconRoot.parent = root;
  // Above the 1.8-unit centre platform, high enough that no figure occludes it from across the arena.
  beaconRoot.position.set(0, 4.6, 0);

  const beaconMaterial = new StandardMaterial('decor-beacon-mat', scene);
  // Above the bloom threshold, so it glows. It is meant to draw the eye, which is the point of a landmark.
  beaconMaterial.emissiveColor = Color3.FromHexString('#ffc76b').scale(1.4);
  beaconMaterial.diffuseColor = Color3.Black();
  beaconMaterial.specularColor = Color3.Black();
  beaconMaterial.disableLighting = true;
  materials.push(beaconMaterial);

  const core = MeshBuilder.CreateIcoSphere(
    'decor-beacon-core',
    { radius: 0.4, subdivisions: 2 },
    scene,
  );
  decorate(core, beaconMaterial);
  core.parent = beaconRoot;

  // Two counter-rotating rings. Motion is what distinguishes a landmark from scenery.
  const ringA = MeshBuilder.CreateTorus(
    'decor-beacon-ring-a',
    { diameter: 1.5, thickness: 0.055, tessellation: 28 },
    scene,
  );
  decorate(ringA, beaconMaterial);
  ringA.parent = beaconRoot;

  const ringB = MeshBuilder.CreateTorus(
    'decor-beacon-ring-b',
    { diameter: 1.9, thickness: 0.045, tessellation: 28 },
    scene,
  );
  ringB.rotation.x = Math.PI / 2;
  decorate(ringB, beaconMaterial);
  ringB.parent = beaconRoot;

  // A mast connecting the beacon to the platform, so it reads as installed rather than floating.
  const mast = MeshBuilder.CreateCylinder(
    'decor-beacon-mast',
    { diameter: 0.12, height: 3.6, tessellation: 8 },
    scene,
  );
  mast.position.set(0, 2.9, 0);
  decorate(mast, trim);

  let beaconVisible = true;

  return {
    root,

    update(now: number): void {
      if (!beaconVisible) return;
      const seconds = now / 1000;
      // Slow and counter-rotating: a fast spin would pull the eye away from enemies, which is a gameplay cost.
      ringA.rotation.y = seconds * 0.5;
      ringB.rotation.z = -seconds * 0.35;
      // A gentle bob, so the beacon is alive even when the player is standing still.
      beaconRoot.position.y = 4.6 + Math.sin(seconds * 0.8) * 0.12;
    },

    applyTier(next: QualityTier): void {
      /*
       * Decoration is cheap but not free: on Low each of these is a draw call competing with the figures that actually matter. The
       * beacon goes first, being the only animated node, and the seams follow.
       */
      const detailed = next.name !== 'low';
      beaconVisible = detailed;
      beaconRoot.setEnabled(detailed);
      mast.setEnabled(detailed);
      ring.setEnabled(detailed);

      for (const mesh of meshes) {
        if (mesh.name.startsWith('decor-seam-')) mesh.setEnabled(detailed);
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
