/**
 * Arena decoration.
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
 * ## Emissive values are relative, not absolute
 *
 * The first version of this file had accents at 1.8 with bloom on top, against arena surfaces at 14% grey. They were by far the
 * brightest thing on screen, and the result was an arena that looked like glowing lines floating in a void: the decoration was
 * carrying the whole scene because nothing else was visible.
 *
 * An emissive value only means something relative to the lit surfaces around it. Now that the arena is properly lit, the accents
 * are much lower and still read as light, because what matters is the ratio and not the number.
 *
 * ## Why per-side colour
 *
 * The arena is perfectly symmetric. That is right for fairness and wrong for orientation: every corner looks the same, so a player
 * who spins around cannot tell which way they are facing. Four accent colours on the four walls solve it for the cost of four
 * materials, and they double as a way to describe positions ("push blue side").
 *
 * ## Why a beacon
 *
 * One strong landmark, above the centre platform, visible from anywhere. It is also the only thing in the scene that moves on its
 * own, which is what makes it read as a landmark rather than as another box.
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

/**
 * Emissive strength for the eye-height strips.
 *
 * Above 1 so bloom's threshold catches them and they read as light rather than paint, but far below the original 1.8: with the
 * arena surfaces now properly lit, an accent that bright dominates everything else on screen.
 */
const ACCENT_STRENGTH = 1.1;
/** The floor-level spill strip. Dimmer than the main strip, since it is meant to look like reflected light. */
const SPILL_STRENGTH = 0.45;

export interface ArenaDecor {
  root: TransformNode;
  /** Animate the beacon. Called once per frame with elapsed milliseconds. */
  update(now: number): void;
  applyTier(tier: QualityTier): void;
  dispose(): void;
}

/** Unlit emissive material for an accent strip. */
function accentMaterial(scene: Scene, name: string, hex: string, strength: number): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  material.emissiveColor = colour.scale(strength);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.disableLighting = true;
  return material;
}

/** Dark material for panel seams and trims. These are lit normally: they are structure, not light. */
function seamMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.FromHexString(hex);
  material.specularColor = new Color3(0.12, 0.12, 0.14);
  material.specularPower = 24;
  return material;
}

export function buildDecor(scene: Scene, tier: QualityTier): ArenaDecor {
  const root = new TransformNode('decor', scene);
  const materials: StandardMaterial[] = [];
  const meshes: Mesh[] = [];

  /** Register a decorative mesh. Never solid, never a shadow caster, never pickable. */
  const decorate = (mesh: Mesh, material: StandardMaterial): void => {
    mesh.parent = root;
    mesh.material = material;
    // The three properties that keep decoration out of gameplay.
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    meshes.push(mesh);
  };

  // Mid greys rather than near-black, so seams and trims are visible as structure instead of as gaps.
  const trim = seamMaterial(scene, 'decor-trim', '#4a5260');
  const panel = seamMaterial(scene, 'decor-panel', '#555e6d');
  materials.push(trim, panel);

  // --- Wall accents and panels -------------------------------------------------------------------
  //
  // One horizontal strip per wall at eye height, plus vertical seams breaking the span into panels. The strip is the navigation
  // cue; the seams stop a 48-unit wall reading as one flat surface.

  const sides: Array<{ side: SideName; x: number; z: number; rotY: number; span: number }> = [
    { side: 'north', x: 0, z: HALF - 0.52, rotY: Math.PI, span: HALF * 2 },
    { side: 'south', x: 0, z: -(HALF - 0.52), rotY: 0, span: HALF * 2 },
    { side: 'east', x: HALF - 0.52, z: 0, rotY: -Math.PI / 2, span: HALF * 2 },
    { side: 'west', x: -(HALF - 0.52), z: 0, rotY: Math.PI / 2, span: HALF * 2 },
  ];

  for (const { side, x, z, rotY, span } of sides) {
    const accent = accentMaterial(scene, `decor-accent-${side}`, SIDE_ACCENTS[side], ACCENT_STRENGTH);
    materials.push(accent);

    /*
     * At 2.4 units: above a crouching player's eye line and below standing head height, so it is visible across the arena without
     * being something a player tries to shelter behind.
     */
    const strip = MeshBuilder.CreatePlane(
      `decor-strip-${side}`,
      { width: span - 2, height: 0.12 },
      scene,
    );
    strip.position.set(x, 2.4, z);
    strip.rotation.y = rotY;
    decorate(strip, accent);

    // A dimmer strip near the floor, reading as spill from the first. Grounds the wall.
    const spill = MeshBuilder.CreatePlane(
      `decor-spill-${side}`,
      { width: span - 2, height: 0.05 },
      scene,
    );
    spill.position.set(x, 0.18, z);
    spill.rotation.y = rotY;
    const dim = accentMaterial(scene, `decor-spill-mat-${side}`, SIDE_ACCENTS[side], SPILL_STRENGTH);
    materials.push(dim);
    decorate(spill, dim);

    // Vertical seams every 8 units, roughly one panel per two cover boxes.
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

    // Top trim: a thin band capping the wall, giving it a finished edge rather than a cut-off.
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

  // --- Floor marking ----------------------------------------------------------------------------
  //
  // A ring around the centre platform. It marks something real, which is the test decoration has to pass.
  //
  // The four lane lines that used to run from here to the pillars are gone: unlit emissive planes lying flat on the floor read as
  // bright wires crossing the arena, and they marked nothing a player needed to know about.

  const paint = accentMaterial(scene, 'decor-paint', '#8d9ab4', 0.8);
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
  // The landmark. Above the centre platform, visible from every corner and from behind cover, and the only thing in the scene that
  // moves on its own.

  const beaconRoot = new TransformNode('decor-beacon', scene);
  beaconRoot.parent = root;
  // Above the 1.8-unit centre platform, high enough that no figure occludes it from across the arena.
  beaconRoot.position.set(0, 4.6, 0);

  const beaconCore = accentMaterial(scene, 'decor-beacon-core', '#ffc76b', 1.6);
  materials.push(beaconCore);

  const core = MeshBuilder.CreateIcoSphere(
    'decor-beacon-core-mesh',
    { radius: 0.4, subdivisions: 2 },
    scene,
  );
  decorate(core, beaconCore);
  core.parent = beaconRoot;

  // Two counter-rotating rings. Motion is what distinguishes a landmark from scenery.
  const ringA = MeshBuilder.CreateTorus(
    'decor-beacon-ring-a',
    { diameter: 1.5, thickness: 0.055, tessellation: 28 },
    scene,
  );
  decorate(ringA, beaconCore);
  ringA.parent = beaconRoot;

  const ringB = MeshBuilder.CreateTorus(
    'decor-beacon-ring-b',
    { diameter: 1.9, thickness: 0.045, tessellation: 28 },
    scene,
  );
  ringB.rotation.x = Math.PI / 2;
  decorate(ringB, beaconCore);
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
       * accents stay, since they are the navigation cue and the cheapest thing here. The beacon goes, being the only animated node.
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
