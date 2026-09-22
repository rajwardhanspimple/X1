/**
 * Shared humanoid rig.
 *
 * One builder, used for enemy figures and for the player's own first-person arms. Having a single
 * definition means proportions cannot drift between the body you shoot at and the arms you look at.
 *
 * The rig is a nested pivot hierarchy rather than flat boxes:
 *
 *   root -> pelvis -> spine -> chest -> neck -> head
 *                              chest -> shoulderL -> upperArmL -> elbowL -> lowerArmL -> handL
 *                              chest -> shoulderR -> upperArmR -> elbowR -> lowerArmR -> handR
 *            pelvis -> hipL -> thighL -> kneeL -> shinL -> footL
 *            pelvis -> hipR -> thighR -> kneeR -> shinR -> footR
 *
 * The elbows and knees matter more than they sound. A limb that is one box rotating from the
 * shoulder reads as a mannequin; two segments with a joint between them read as a person, and it is
 * the single largest improvement available for the cost.
 *
 * Nothing here is read by the simulation. The simulation's enemy hitbox is still a single upright
 * box, deliberately: hit detection stays cheap, exact and deterministic while the visuals get as
 * detailed as the frame budget allows.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';

/** Proportions, in world units. Total standing height is 1.8 to match the simulation hitbox. */
export const RIG = {
  totalHeight: 1.8,
  /** Pelvis height above the feet. */
  pelvisY: 0.92,
  spineLength: 0.18,
  chestLength: 0.34,
  chestWidth: 0.46,
  chestDepth: 0.26,
  waistWidth: 0.34,
  neckLength: 0.08,
  headSize: 0.24,
  shoulderOffset: 0.235,
  upperArmLength: 0.29,
  lowerArmLength: 0.26,
  armThickness: 0.095,
  handSize: 0.1,
  hipOffset: 0.115,
  thighLength: 0.46,
  shinLength: 0.44,
  legThickness: 0.125,
  footLength: 0.24,
  footHeight: 0.07,
} as const;

export interface HumanoidRig {
  root: TransformNode;
  pelvis: TransformNode;
  spine: TransformNode;
  chest: TransformNode;
  neck: TransformNode;
  head: Mesh;
  shoulderLeft: TransformNode;
  shoulderRight: TransformNode;
  elbowLeft: TransformNode;
  elbowRight: TransformNode;
  handLeft: TransformNode;
  handRight: TransformNode;
  hipLeft: TransformNode;
  hipRight: TransformNode;
  kneeLeft: TransformNode;
  kneeRight: TransformNode;
  /** Every mesh, for visibility fades and shadow registration. */
  meshes: Mesh[];
  /** Meshes that take the team or archetype colour. */
  skinMeshes: Mesh[];
}

export interface RigMaterials {
  /** Chest, head, upper arms: the identifying colour. */
  skin: Material | null;
  /** Legs, lower arms, boots: darker, so limbs read against the torso. */
  dark: Material | null;
  /** Hands and gear. */
  accent: Material | null;
}

function box(
  scene: Scene,
  name: string,
  width: number,
  height: number,
  depth: number,
): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
  mesh.isPickable = false;
  return mesh;
}

/**
 * Build a figure. `id` only has to be unique within the scene; it is used for node names, which
 * matters when debugging in the Babylon inspector.
 */
export function buildHumanoid(scene: Scene, id: string, materials: RigMaterials): HumanoidRig {
  const meshes: Mesh[] = [];
  const skinMeshes: Mesh[] = [];

  const root = new TransformNode(`rig-${id}`, scene);

  // --- Torso ---------------------------------------------------------------------------------
  const pelvis = new TransformNode(`rig-${id}-pelvis`, scene);
  pelvis.parent = root;
  pelvis.position.y = RIG.pelvisY;

  const waist = box(scene, `rig-${id}-waist`, RIG.waistWidth, RIG.spineLength, RIG.chestDepth * 0.9);
  waist.parent = pelvis;
  waist.position.y = RIG.spineLength / 2;
  waist.material = materials.dark;
  meshes.push(waist);

  // The spine pivot is what a hit flinch or a death collapse rotates.
  const spine = new TransformNode(`rig-${id}-spine`, scene);
  spine.parent = pelvis;
  spine.position.y = RIG.spineLength;

  const chest = new TransformNode(`rig-${id}-chest`, scene);
  chest.parent = spine;

  const chestMesh = box(scene, `rig-${id}-chest-mesh`, RIG.chestWidth, RIG.chestLength, RIG.chestDepth);
  chestMesh.parent = chest;
  chestMesh.position.y = RIG.chestLength / 2;
  chestMesh.material = materials.skin;
  meshes.push(chestMesh);
  skinMeshes.push(chestMesh);

  // A slightly narrower plate on the front reads as body armour and breaks up the flat box.
  const vest = box(scene, `rig-${id}-vest`, RIG.chestWidth * 0.82, RIG.chestLength * 0.7, 0.06);
  vest.parent = chest;
  vest.position.set(0, RIG.chestLength * 0.52, RIG.chestDepth / 2);
  vest.material = materials.dark;
  meshes.push(vest);

  const neck = new TransformNode(`rig-${id}-neck`, scene);
  neck.parent = chest;
  neck.position.y = RIG.chestLength;

  const neckMesh = box(scene, `rig-${id}-neck-mesh`, 0.1, RIG.neckLength, 0.1);
  neckMesh.parent = neck;
  neckMesh.position.y = RIG.neckLength / 2;
  neckMesh.material = materials.dark;
  meshes.push(neckMesh);

  const head = box(scene, `rig-${id}-head`, RIG.headSize, RIG.headSize, RIG.headSize * 0.92);
  head.parent = neck;
  head.position.y = RIG.neckLength + RIG.headSize / 2;
  head.material = materials.skin;
  meshes.push(head);
  skinMeshes.push(head);

  // A visor band gives the head a facing direction, which matters for reading where an enemy looks.
  const visor = box(scene, `rig-${id}-visor`, RIG.headSize * 0.9, 0.06, 0.04);
  visor.parent = head;
  visor.position.set(0, 0.02, RIG.headSize * 0.46);
  visor.material = materials.accent;
  meshes.push(visor);

  // --- Arms ----------------------------------------------------------------------------------
  function buildArm(side: 'l' | 'r'): {
    shoulder: TransformNode;
    elbow: TransformNode;
    hand: TransformNode;
  } {
    const sign = side === 'l' ? -1 : 1;

    const shoulder = new TransformNode(`rig-${id}-shoulder-${side}`, scene);
    shoulder.parent = chest;
    shoulder.position.set(sign * RIG.shoulderOffset, RIG.chestLength * 0.86, 0);

    const upper = box(
      scene,
      `rig-${id}-upperarm-${side}`,
      RIG.armThickness,
      RIG.upperArmLength,
      RIG.armThickness,
    );
    upper.parent = shoulder;
    // Hangs downward from the pivot, so rotating the pivot swings it from the shoulder.
    upper.position.y = -RIG.upperArmLength / 2;
    upper.material = materials.skin;
    meshes.push(upper);
    skinMeshes.push(upper);

    const elbow = new TransformNode(`rig-${id}-elbow-${side}`, scene);
    elbow.parent = shoulder;
    elbow.position.y = -RIG.upperArmLength;

    const lower = box(
      scene,
      `rig-${id}-lowerarm-${side}`,
      RIG.armThickness * 0.9,
      RIG.lowerArmLength,
      RIG.armThickness * 0.9,
    );
    lower.parent = elbow;
    lower.position.y = -RIG.lowerArmLength / 2;
    lower.material = materials.dark;
    meshes.push(lower);

    const hand = new TransformNode(`rig-${id}-hand-${side}`, scene);
    hand.parent = elbow;
    hand.position.y = -RIG.lowerArmLength;

    const handMesh = box(
      scene,
      `rig-${id}-hand-mesh-${side}`,
      RIG.handSize,
      RIG.handSize,
      RIG.handSize * 0.8,
    );
    handMesh.parent = hand;
    handMesh.position.y = -RIG.handSize / 2;
    handMesh.material = materials.accent;
    meshes.push(handMesh);

    return { shoulder, elbow, hand };
  }

  const armLeft = buildArm('l');
  const armRight = buildArm('r');

  // --- Legs ----------------------------------------------------------------------------------
  function buildLeg(side: 'l' | 'r'): { hip: TransformNode; knee: TransformNode } {
    const sign = side === 'l' ? -1 : 1;

    const hip = new TransformNode(`rig-${id}-hip-${side}`, scene);
    hip.parent = pelvis;
    hip.position.set(sign * RIG.hipOffset, 0, 0);

    const thigh = box(
      scene,
      `rig-${id}-thigh-${side}`,
      RIG.legThickness,
      RIG.thighLength,
      RIG.legThickness,
    );
    thigh.parent = hip;
    thigh.position.y = -RIG.thighLength / 2;
    thigh.material = materials.dark;
    meshes.push(thigh);

    const knee = new TransformNode(`rig-${id}-knee-${side}`, scene);
    knee.parent = hip;
    knee.position.y = -RIG.thighLength;

    const shin = box(
      scene,
      `rig-${id}-shin-${side}`,
      RIG.legThickness * 0.88,
      RIG.shinLength,
      RIG.legThickness * 0.88,
    );
    shin.parent = knee;
    shin.position.y = -RIG.shinLength / 2;
    shin.material = materials.dark;
    meshes.push(shin);

    const foot = box(scene, `rig-${id}-foot-${side}`, RIG.legThickness, RIG.footHeight, RIG.footLength);
    foot.parent = knee;
    // Sits at the bottom of the shin, extending forward.
    foot.position.set(0, -RIG.shinLength - RIG.footHeight / 2 + 0.01, RIG.footLength * 0.22);
    foot.material = materials.accent;
    meshes.push(foot);

    return { hip, knee };
  }

  const legLeft = buildLeg('l');
  const legRight = buildLeg('r');

  return {
    root,
    pelvis,
    spine,
    chest,
    neck,
    head,
    shoulderLeft: armLeft.shoulder,
    shoulderRight: armRight.shoulder,
    elbowLeft: armLeft.elbow,
    elbowRight: armRight.elbow,
    handLeft: armLeft.hand,
    handRight: armRight.hand,
    hipLeft: legLeft.hip,
    hipRight: legRight.hip,
    kneeLeft: legLeft.knee,
    kneeRight: legRight.knee,
    meshes,
    skinMeshes,
  };
}

/**
 * Pose the arms into a two-handed weapon grip.
 *
 * The right hand holds the grip near the chest, the left hand supports the handguard further
 * forward. Called once when a figure is built and again whenever the aim pose changes, so the gun
 * always sits in the hands rather than floating beside them.
 */
export function poseWeaponGrip(rig: HumanoidRig, aiming: boolean): void {
  // Shoulders rotate forward so the arms come up in front of the chest.
  rig.shoulderRight.rotation.set(aiming ? -1.32 : -1.08, -0.22, 0.16);
  rig.elbowRight.rotation.set(aiming ? 1.02 : 0.86, 0, 0);

  rig.shoulderLeft.rotation.set(aiming ? -1.42 : -1.16, 0.4, -0.2);
  rig.elbowLeft.rotation.set(aiming ? 1.24 : 1.02, 0, 0);
}

/** Reset every joint to the neutral standing pose. */
export function resetPose(rig: HumanoidRig): void {
  rig.root.rotation.set(0, 0, 0);
  rig.root.position.set(0, 0, 0);
  rig.pelvis.rotation.set(0, 0, 0);
  rig.pelvis.position.y = RIG.pelvisY;
  rig.spine.rotation.set(0, 0, 0);
  rig.chest.rotation.set(0, 0, 0);
  rig.neck.rotation.set(0, 0, 0);
  rig.shoulderLeft.rotation.set(0, 0, 0);
  rig.shoulderRight.rotation.set(0, 0, 0);
  rig.elbowLeft.rotation.set(0, 0, 0);
  rig.elbowRight.rotation.set(0, 0, 0);
  rig.hipLeft.rotation.set(0, 0, 0);
  rig.hipRight.rotation.set(0, 0, 0);
  rig.kneeLeft.rotation.set(0, 0, 0);
  rig.kneeRight.rotation.set(0, 0, 0);
}
