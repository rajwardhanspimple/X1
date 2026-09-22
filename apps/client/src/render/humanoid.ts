/**
 * Shared humanoid rig.
 *
 * One builder, used for enemy figures and for the player's own first-person arms. Having a single
 * definition means proportions cannot drift between the body you shoot at and the arms you look at.
 *
 * The rig is a nested pivot hierarchy:
 *
 *   root -> pelvis -> spine -> chest -> neck -> head
 *                              chest -> shoulderL -> elbowL -> handL
 *                              chest -> shoulderR -> elbowR -> handR
 *            pelvis -> hipL -> kneeL -> footL
 *            pelvis -> hipR -> kneeR -> footR
 *
 * Three shape decisions matter more than anything else here, and the first version got all three
 * wrong by using plain boxes:
 *
 * Limbs TAPER. An upper arm is thick at the shoulder and thinner at the elbow; a thigh is much
 * thicker at the hip than at the knee. A constant-thickness limb reads as a mannequin however well
 * it animates, so every limb is a tapered cylinder rather than a box.
 *
 * Joints get SPHERES. Two tapered segments meeting at a bent elbow leave either a visible gap or an
 * intersecting corner. A sphere at the joint fills it and the limb reads as continuous. This is the
 * highest-value detail in the figure relative to its cost.
 *
 * The torso and head are ROUNDED. A cube head is the single most obvious tell, and a chest that
 * tapers into a narrower waist gives the silhouette a direction.
 *
 * Tessellation is a parameter rather than a constant, because rounded geometry is far more expensive
 * than boxes: a sphere at 16 segments is roughly 30 times the vertices of a cube. At arena distances
 * 8 segments still reads as rounded, so the quality tier picks the count.
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
  waistLength: 0.2,
  waistTop: 0.3,
  waistBottom: 0.34,
  chestLength: 0.36,
  /** Chest is widest at the shoulders and narrows into the waist. */
  chestTop: 0.42,
  chestBottom: 0.32,
  /** Horizontal squash on the torso, so it is oval in plan rather than circular. */
  torsoDepthScale: 0.72,
  neckLength: 0.09,
  neckDiameter: 0.12,
  headDiameter: 0.23,
  shoulderOffset: 0.2,
  shoulderBall: 0.15,
  upperArmLength: 0.29,
  upperArmTop: 0.125,
  upperArmBottom: 0.1,
  elbowBall: 0.1,
  lowerArmLength: 0.26,
  lowerArmTop: 0.1,
  lowerArmBottom: 0.075,
  handLength: 0.12,
  hipOffset: 0.105,
  hipBall: 0.17,
  thighLength: 0.45,
  thighTop: 0.185,
  thighBottom: 0.135,
  kneeBall: 0.135,
  shinLength: 0.43,
  shinTop: 0.13,
  shinBottom: 0.085,
  ankleBall: 0.09,
  footLength: 0.26,
  footHeight: 0.08,
  footWidth: 0.11,
} as const;

/** Vertex budget per figure. Low keeps the silhouette rounded at a third of the cost. */
export type RigDetail = 'low' | 'high';

function segmentsFor(detail: RigDetail): { radial: number; sphere: number } {
  return detail === 'high' ? { radial: 16, sphere: 12 } : { radial: 8, sphere: 6 };
}

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
  /** Hands, joints and gear. */
  accent: Material | null;
}

export function buildHumanoid(
  scene: Scene,
  id: string,
  materials: RigMaterials,
  detail: RigDetail = 'high',
): HumanoidRig {
  const seg = segmentsFor(detail);
  const meshes: Mesh[] = [];
  const skinMeshes: Mesh[] = [];

  /** Tapered segment, hanging downward from its pivot so a rotation swings it from the joint. */
  function limb(
    name: string,
    length: number,
    top: number,
    bottom: number,
    parent: TransformNode,
    material: Material | null,
  ): Mesh {
    const mesh = MeshBuilder.CreateCylinder(
      name,
      { height: length, diameterTop: top, diameterBottom: bottom, tessellation: seg.radial },
      scene,
    );
    mesh.parent = parent;
    mesh.position.y = -length / 2;
    mesh.material = material;
    mesh.isPickable = false;
    meshes.push(mesh);
    return mesh;
  }

  /** Ball at a joint. Without these a bent limb shows a gap or an intersecting corner. */
  function joint(
    name: string,
    diameter: number,
    parent: TransformNode,
    material: Material | null,
  ): Mesh {
    const mesh = MeshBuilder.CreateSphere(name, { diameter, segments: seg.sphere }, scene);
    mesh.parent = parent;
    mesh.material = material;
    mesh.isPickable = false;
    meshes.push(mesh);
    return mesh;
  }

  const root = new TransformNode(`rig-${id}`, scene);

  // --- Torso ---------------------------------------------------------------------------------
  const pelvis = new TransformNode(`rig-${id}-pelvis`, scene);
  pelvis.parent = root;
  pelvis.position.y = RIG.pelvisY;

  // Waist tapers upward into the chest. Scaled on Z so the torso is oval in plan, not a tube.
  const waist = MeshBuilder.CreateCylinder(
    `rig-${id}-waist`,
    {
      height: RIG.waistLength,
      diameterTop: RIG.waistTop,
      diameterBottom: RIG.waistBottom,
      tessellation: seg.radial,
    },
    scene,
  );
  waist.parent = pelvis;
  waist.position.y = RIG.waistLength / 2;
  waist.scaling.z = RIG.torsoDepthScale;
  waist.material = materials.dark;
  waist.isPickable = false;
  meshes.push(waist);

  // The spine pivot is what a hit flinch or a death collapse rotates.
  const spine = new TransformNode(`rig-${id}-spine`, scene);
  spine.parent = pelvis;
  spine.position.y = RIG.waistLength;

  const chest = new TransformNode(`rig-${id}-chest`, scene);
  chest.parent = spine;

  /*
   * Chest is wider at the top than the bottom: an inverted taper, which is what gives a torso
   * shoulders instead of a barrel.
   */
  const chestMesh = MeshBuilder.CreateCylinder(
    `rig-${id}-chest-mesh`,
    {
      height: RIG.chestLength,
      diameterTop: RIG.chestTop,
      diameterBottom: RIG.chestBottom,
      tessellation: seg.radial,
    },
    scene,
  );
  chestMesh.parent = chest;
  chestMesh.position.y = RIG.chestLength / 2;
  chestMesh.scaling.z = RIG.torsoDepthScale;
  chestMesh.material = materials.skin;
  chestMesh.isPickable = false;
  meshes.push(chestMesh);
  skinMeshes.push(chestMesh);

  // A curved plate on the front reads as body armour and breaks up the silhouette.
  const vest = MeshBuilder.CreateCylinder(
    `rig-${id}-vest`,
    {
      height: RIG.chestLength * 0.66,
      diameterTop: RIG.chestTop * 0.88,
      diameterBottom: RIG.chestBottom * 0.92,
      tessellation: seg.radial,
      arc: 0.42,
    },
    scene,
  );
  vest.parent = chest;
  vest.position.set(0, RIG.chestLength * 0.5, 0.012);
  // Rotated so the open arc faces forward, and scaled out slightly to sit on the chest surface.
  vest.rotation.y = -Math.PI * 0.42;
  vest.scaling.set(1.06, 1, RIG.torsoDepthScale * 1.1);
  vest.material = materials.dark;
  vest.isPickable = false;
  meshes.push(vest);

  const neck = new TransformNode(`rig-${id}-neck`, scene);
  neck.parent = chest;
  neck.position.y = RIG.chestLength;

  const neckMesh = MeshBuilder.CreateCylinder(
    `rig-${id}-neck-mesh`,
    {
      height: RIG.neckLength,
      diameterTop: RIG.neckDiameter * 0.92,
      diameterBottom: RIG.neckDiameter,
      tessellation: seg.radial,
    },
    scene,
  );
  neckMesh.parent = neck;
  neckMesh.position.y = RIG.neckLength / 2;
  neckMesh.material = materials.dark;
  neckMesh.isPickable = false;
  meshes.push(neckMesh);

  /*
   * Head: a sphere squashed on X and stretched slightly on Z, which is closer to a skull than either
   * a cube or a ball. A cube head is the most obvious tell that a figure is placeholder geometry.
   */
  const head = MeshBuilder.CreateSphere(
    `rig-${id}-head`,
    { diameter: RIG.headDiameter, segments: seg.sphere + 2 },
    scene,
  );
  head.parent = neck;
  head.position.y = RIG.neckLength + RIG.headDiameter * 0.48;
  head.scaling.set(0.88, 1.04, 0.96);
  head.material = materials.skin;
  head.isPickable = false;
  meshes.push(head);
  skinMeshes.push(head);

  // Jaw: a smaller sphere low and forward, so the head has a front.
  const jaw = MeshBuilder.CreateSphere(
    `rig-${id}-jaw`,
    { diameter: RIG.headDiameter * 0.74, segments: seg.sphere },
    scene,
  );
  jaw.parent = head;
  jaw.position.set(0, -RIG.headDiameter * 0.18, RIG.headDiameter * 0.16);
  jaw.scaling.set(0.9, 0.78, 1);
  jaw.material = materials.skin;
  jaw.isPickable = false;
  meshes.push(jaw);
  skinMeshes.push(jaw);

  // A visor band gives the head a facing direction, which matters for reading where an enemy looks.
  const visor = MeshBuilder.CreateCylinder(
    `rig-${id}-visor`,
    {
      height: RIG.headDiameter * 0.3,
      diameter: RIG.headDiameter * 0.94,
      tessellation: seg.radial,
      arc: 0.34,
    },
    scene,
  );
  visor.parent = head;
  visor.position.set(0, RIG.headDiameter * 0.08, 0);
  visor.rotation.y = -Math.PI * 0.42;
  visor.scaling.z = 1.02;
  visor.material = materials.accent;
  visor.isPickable = false;
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
    shoulder.position.set(sign * RIG.shoulderOffset, RIG.chestLength * 0.84, 0);

    // Deltoid ball. Also hides the seam where the arm meets the chest.
    const deltoid = joint(
      `rig-${id}-deltoid-${side}`,
      RIG.shoulderBall,
      shoulder,
      materials.skin,
    );
    skinMeshes.push(deltoid);

    const upper = limb(
      `rig-${id}-upperarm-${side}`,
      RIG.upperArmLength,
      RIG.upperArmTop,
      RIG.upperArmBottom,
      shoulder,
      materials.skin,
    );
    skinMeshes.push(upper);

    const elbow = new TransformNode(`rig-${id}-elbow-${side}`, scene);
    elbow.parent = shoulder;
    elbow.position.y = -RIG.upperArmLength;

    joint(`rig-${id}-elbowball-${side}`, RIG.elbowBall, elbow, materials.dark);

    limb(
      `rig-${id}-lowerarm-${side}`,
      RIG.lowerArmLength,
      RIG.lowerArmTop,
      RIG.lowerArmBottom,
      elbow,
      materials.dark,
    );

    const hand = new TransformNode(`rig-${id}-hand-${side}`, scene);
    hand.parent = elbow;
    hand.position.y = -RIG.lowerArmLength;

    // Hand: a squashed sphere rather than a cube. Reads as a fist at any distance.
    const handMesh = MeshBuilder.CreateSphere(
      `rig-${id}-hand-mesh-${side}`,
      { diameter: RIG.handLength, segments: seg.sphere },
      scene,
    );
    handMesh.parent = hand;
    handMesh.position.y = -RIG.handLength * 0.4;
    handMesh.scaling.set(0.82, 1.1, 0.88);
    handMesh.material = materials.accent;
    handMesh.isPickable = false;
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

    joint(`rig-${id}-hipball-${side}`, RIG.hipBall, hip, materials.dark);

    limb(
      `rig-${id}-thigh-${side}`,
      RIG.thighLength,
      RIG.thighTop,
      RIG.thighBottom,
      hip,
      materials.dark,
    );

    const knee = new TransformNode(`rig-${id}-knee-${side}`, scene);
    knee.parent = hip;
    knee.position.y = -RIG.thighLength;

    joint(`rig-${id}-kneeball-${side}`, RIG.kneeBall, knee, materials.dark);

    limb(
      `rig-${id}-shin-${side}`,
      RIG.shinLength,
      RIG.shinTop,
      RIG.shinBottom,
      knee,
      materials.dark,
    );

    // Ankle ball, then a boot that extends forward.
    const ankle = new TransformNode(`rig-${id}-ankle-${side}`, scene);
    ankle.parent = knee;
    ankle.position.y = -RIG.shinLength;
    joint(`rig-${id}-ankleball-${side}`, RIG.ankleBall, ankle, materials.accent);

    const foot = MeshBuilder.CreateCylinder(
      `rig-${id}-foot-${side}`,
      {
        height: RIG.footLength,
        diameterTop: RIG.footWidth * 0.8,
        diameterBottom: RIG.footWidth,
        tessellation: seg.radial,
      },
      scene,
    );
    foot.parent = ankle;
    // Laid on its side and pushed forward, so it reads as a boot rather than a peg.
    foot.rotation.x = Math.PI / 2;
    foot.position.set(0, -RIG.footHeight * 0.5, RIG.footLength * 0.22);
    foot.scaling.set(1, 1, 0.62);
    foot.material = materials.accent;
    foot.isPickable = false;
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
 * forward. Called when a figure is built and whenever the aim pose changes, so the gun always sits
 * in the hands rather than floating beside them.
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
