/**
 * Model diagnostics.
 *
 * Split out because it is read-only inspection, not loading, and because it answers a specific question
 * cheaply: what is actually in this file?
 *
 * The enemy renderer assumes a loaded character brings its own weapon geometry and adds none of its own.
 * If that assumption is wrong for a given model, the weapon-ready and firing poses mime with empty
 * hands, which presents as an animation bug while actually being an asset question. Naming the meshes at
 * load is how that gets settled in one line instead of by guesswork.
 */

import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton.js';

/**
 * Substrings that suggest a mesh is a weapon rather than part of the body.
 *
 * Deliberately broad. A false positive here costs a wrong log line; a false negative means concluding a
 * model has no weapon when it does.
 */
const WEAPON_HINTS = [
  'gun',
  'rifle',
  'weapon',
  'pistol',
  'smg',
  'ak',
  'm4',
  'carbine',
  'barrel',
  'magazine',
  'mag',
  'scope',
  'sword',
  'knife',
  'blade',
];

/** Substrings that identify a hand bone, for attaching a weapon that the model does not include. */
const HAND_BONE_HINTS = ['hand', 'wrist', 'palm', 'grip'];

export interface ModelInspection {
  meshNames: string[];
  /** Meshes whose names suggest a weapon. Empty means the model probably has none. */
  weaponMeshNames: string[];
  boneCount: number;
  /** Bones that could serve as a weapon attachment point, right hand preferred. */
  handBoneNames: string[];
}

export function inspectModel(
  meshes: readonly AbstractMesh[],
  skeleton: Skeleton | null,
): ModelInspection {
  const meshNames = meshes.map((m) => m.name).filter((n) => n.length > 0);

  const weaponMeshNames = meshNames.filter((name) => {
    const lower = name.toLowerCase();
    return WEAPON_HINTS.some((hint) => lower.includes(hint));
  });

  const bones = skeleton?.bones ?? [];
  const handBoneNames = bones
    .map((b) => b.name)
    .filter((name) => {
      const lower = name.toLowerCase();
      return HAND_BONE_HINTS.some((hint) => lower.includes(hint));
    });

  return {
    meshNames,
    weaponMeshNames,
    boneCount: bones.length,
    handBoneNames,
  };
}

/**
 * Log what the model contains.
 *
 * Kept to a few lines: a console flooded with per-mesh detail is ignored, and the only questions that
 * matter here are whether there is a weapon and where one could be attached.
 */
export function logInspection(inspection: ModelInspection): void {
  console.info(`[rearena] meshes: ${inspection.meshNames.join(', ')}`);

  if (inspection.weaponMeshNames.length > 0) {
    console.info(`[rearena] weapon geometry found: ${inspection.weaponMeshNames.join(', ')}`);
  } else {
    /*
     * The important case. Weapon-ready poses without weapon geometry look like a broken animation, so
     * say plainly that the pose is correct and the gun is simply absent from the file.
     */
    console.warn(
      '[rearena] no weapon mesh in this model: the aim and shoot poses will hold empty hands',
    );
  }

  if (inspection.boneCount === 0) {
    console.warn('[rearena] model has no skeleton; it cannot be posed or animated');
  } else if (inspection.handBoneNames.length > 0) {
    console.info(
      `[rearena] ${inspection.boneCount} bones, hand candidates: ${inspection.handBoneNames.join(', ')}`,
    );
  } else {
    console.info(`[rearena] ${inspection.boneCount} bones, no hand bone matched by name`);
  }
}
