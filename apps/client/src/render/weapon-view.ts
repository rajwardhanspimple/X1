/**
 * First-person weapon view model, with arms.
 *
 * Built from primitives rather than a loaded asset: the content pipeline does not exist yet
 * (WO-7), and a blocked-out gun that reads clearly is more useful now than a placeholder cube.
 *
 * The structure matters. The whole assembly is parented to the camera, and the ARMS are parented to
 * the WEAPON, not to the camera. That ordering is what makes it look like the gun is being held:
 * recoil, sway and the reload tilt move hands and weapon as one object. Parenting them separately
 * produces two things animating near each other, which the eye reads immediately as wrong.
 *
 * Everything here is cosmetic. It reads the snapshot and the event stream and never feeds anything
 * back into the simulation, so none of this motion can affect a run or its verification.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';

/** Resting position of the assembly in view space: right, down, forward. */
const HIP_POSITION = new Vector3(0.2, -0.22, 0.5);
const HIP_ROTATION = new Vector3(0.03, -0.07, 0);
/** Aiming brings it to centre and closer, which is what sells the sight picture. */
const ADS_POSITION = new Vector3(0, -0.105, 0.36);
const ADS_ROTATION = new Vector3(0, 0, 0);

const KICK_BACK = 0.085;
const KICK_UP = 0.048;
const KICK_ROLL = 0.055;

function material(scene: Scene, name: string, hex: string, emissive = 0): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  m.diffuseColor = colour;
  m.specularColor = new Color3(0.22, 0.22, 0.24);
  m.specularPower = 52;
  m.emissiveColor = colour.scale(emissive);
  return m;
}

interface Pose {
  position: Vector3;
  rotation: Vector3;
}

export class WeaponViewModel {
  private readonly root: TransformNode;
  private readonly parts: Mesh[] = [];
  private readonly muzzle: TransformNode;
  private readonly flash: Mesh;
  /** Left hand pivot, so it can be pulled back during a reload. */
  private readonly leftArm: TransformNode;

  /** Smoothed values, so a pose change eases rather than snapping. */
  private adsBlend = 0;
  private kick = 0;
  private reloadBlend = 0;
  private swayPhase = 0;
  private swayAmount = 0;
  private flashUntil = 0;

  constructor(
    private readonly scene: Scene,
    camera: Camera,
  ) {
    this.root = new TransformNode('weapon-root', scene);
    this.root.parent = camera;
    this.root.position.copyFrom(HIP_POSITION);

    const bodyMat = material(scene, 'weapon-body', '#2a2f3a');
    const metalMat = material(scene, 'weapon-metal', '#4a5261');
    const gripMat = material(scene, 'weapon-grip', '#1a1e25');
    // Gloves rather than skin: a neutral dark colour avoids the uncanny look of untextured skin
    // tones and matches the enemy figures' hands.
    const gloveMat = material(scene, 'weapon-glove', '#23272f');
    const sleeveMat = material(scene, 'weapon-sleeve', '#2f3644');

    // --- Weapon ------------------------------------------------------------------------------
    const body = MeshBuilder.CreateBox(
      'weapon-body',
      { width: 0.072, height: 0.098, depth: 0.42 },
      scene,
    );
    body.material = bodyMat;
    this.parts.push(body);

    const barrel = MeshBuilder.CreateCylinder(
      'weapon-barrel',
      { diameter: 0.03, height: 0.34, tessellation: 10 },
      scene,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.022, 0.35);
    barrel.material = metalMat;
    this.parts.push(barrel);

    const guard = MeshBuilder.CreateBox(
      'weapon-guard',
      { width: 0.056, height: 0.052, depth: 0.2 },
      scene,
    );
    guard.position.set(0, 0.012, 0.25);
    guard.material = bodyMat;
    this.parts.push(guard);

    const mag = MeshBuilder.CreateBox(
      'weapon-mag',
      { width: 0.048, height: 0.155, depth: 0.072 },
      scene,
    );
    mag.position.set(0, -0.112, 0.095);
    mag.rotation.x = -0.12;
    mag.material = gripMat;
    this.parts.push(mag);

    const grip = MeshBuilder.CreateBox(
      'weapon-grip',
      { width: 0.044, height: 0.135, depth: 0.058 },
      scene,
    );
    grip.position.set(0, -0.1, -0.07);
    grip.rotation.x = 0.3;
    grip.material = gripMat;
    this.parts.push(grip);

    const stock = MeshBuilder.CreateBox(
      'weapon-stock',
      { width: 0.048, height: 0.082, depth: 0.2 },
      scene,
    );
    stock.position.set(0, -0.012, -0.27);
    stock.material = bodyMat;
    this.parts.push(stock);

    const rearSight = MeshBuilder.CreateBox(
      'weapon-sight-rear',
      { width: 0.034, height: 0.028, depth: 0.015 },
      scene,
    );
    rearSight.position.set(0, 0.064, 0.02);
    rearSight.material = metalMat;
    this.parts.push(rearSight);

    const frontSight = MeshBuilder.CreateBox(
      'weapon-sight-front',
      { width: 0.013, height: 0.034, depth: 0.013 },
      scene,
    );
    frontSight.position.set(0, 0.06, 0.43);
    frontSight.material = metalMat;
    this.parts.push(frontSight);

    // --- Right arm: on the grip, with a trigger finger ---------------------------------------
    const rightArm = new TransformNode('weapon-arm-r', scene);
    rightArm.parent = this.root;

    const rightForearm = MeshBuilder.CreateBox(
      'weapon-forearm-r',
      { width: 0.085, height: 0.085, depth: 0.3 },
      scene,
    );
    rightForearm.parent = rightArm;
    // Runs back and down from the grip toward the shoulder, which is off-screen.
    rightForearm.position.set(0.035, -0.17, -0.22);
    rightForearm.rotation.set(0.42, -0.1, 0);
    rightForearm.material = sleeveMat;
    this.parts.push(rightForearm);

    const rightHand = MeshBuilder.CreateBox(
      'weapon-hand-r',
      { width: 0.08, height: 0.1, depth: 0.09 },
      scene,
    );
    rightHand.parent = rightArm;
    rightHand.position.set(0.012, -0.075, -0.055);
    rightHand.rotation.x = 0.28;
    rightHand.material = gloveMat;
    this.parts.push(rightHand);

    // Trigger finger, forward of the hand. A small detail, but it is what makes the grip read.
    const trigger = MeshBuilder.CreateBox(
      'weapon-finger-r',
      { width: 0.022, height: 0.022, depth: 0.05 },
      scene,
    );
    trigger.parent = rightArm;
    trigger.position.set(0.012, -0.042, -0.015);
    trigger.material = gloveMat;
    this.parts.push(trigger);

    // --- Left arm: wrapped over the handguard ------------------------------------------------
    this.leftArm = new TransformNode('weapon-arm-l', scene);
    this.leftArm.parent = this.root;

    const leftForearm = MeshBuilder.CreateBox(
      'weapon-forearm-l',
      { width: 0.082, height: 0.082, depth: 0.28 },
      scene,
    );
    leftForearm.parent = this.leftArm;
    // Comes up and across from the left, under the barrel.
    leftForearm.position.set(-0.1, -0.14, 0.12);
    leftForearm.rotation.set(0.62, 0.34, 0);
    leftForearm.material = sleeveMat;
    this.parts.push(leftForearm);

    const leftHand = MeshBuilder.CreateBox(
      'weapon-hand-l',
      { width: 0.09, height: 0.085, depth: 0.1 },
      scene,
    );
    leftHand.parent = this.leftArm;
    leftHand.position.set(-0.022, -0.055, 0.245);
    leftHand.rotation.set(0.1, 0.18, 0.2);
    leftHand.material = gloveMat;
    this.parts.push(leftHand);

    // Thumb over the top of the handguard.
    const leftThumb = MeshBuilder.CreateBox(
      'weapon-thumb-l',
      { width: 0.05, height: 0.02, depth: 0.022 },
      scene,
    );
    leftThumb.parent = this.leftArm;
    leftThumb.position.set(-0.004, -0.012, 0.25);
    leftThumb.material = gloveMat;
    this.parts.push(leftThumb);

    for (const part of this.parts) {
      if (!part.parent) part.parent = this.root;
      /*
       * Rendering group 1: the assembly sits centimetres from the near plane and would otherwise
       * clip through any wall the player stands against.
       */
      part.renderingGroupId = 1;
      part.isPickable = false;
    }

    // Muzzle marker: where the flash sits and where a tracer appears to start.
    this.muzzle = new TransformNode('weapon-muzzle', scene);
    this.muzzle.parent = this.root;
    this.muzzle.position.set(0, 0.022, 0.54);

    const flashMat = material(scene, 'weapon-flash', '#ffd27f', 2.4);
    flashMat.disableLighting = true;
    this.flash = MeshBuilder.CreatePlane('weapon-flash', { size: 0.24 }, scene);
    this.flash.parent = this.muzzle;
    this.flash.renderingGroupId = 1;
    this.flash.isPickable = false;
    this.flash.material = flashMat;
    this.flash.setEnabled(false);
    // Always face the camera, so a flat plane reads as a burst from any angle.
    this.flash.billboardMode = 7;
  }

  /** World position of the muzzle, for tracer origins and casing ejection. */
  muzzleWorldPosition(): Vector3 {
    return this.muzzle.getAbsolutePosition();
  }

  onShot(now: number): void {
    // Additive, so sustained fire climbs instead of resetting to the same kick each shot.
    this.kick = Math.min(1, this.kick + 0.72);
    this.flashUntil = now + 45;
  }

  onReloadStart(): void {
    this.reloadBlend = 1;
  }

  /**
   * Per-frame update. dt is in seconds and only drives easing, so a frame-rate change alters how
   * smooth the animation looks and nothing else.
   */
  update(options: {
    now: number;
    dt: number;
    aiming: boolean;
    reloading: boolean;
    movingSpeed: number;
  }): void {
    const { now, dt, aiming, reloading, movingSpeed } = options;

    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);

    this.adsBlend = ease(this.adsBlend, aiming ? 1 : 0, 14);
    this.reloadBlend = ease(this.reloadBlend, reloading ? 1 : 0, 9);
    this.kick = ease(this.kick, 0, 11);

    this.swayAmount = ease(this.swayAmount, Math.min(1, movingSpeed / 7), 6);
    this.swayPhase += dt * (4 + movingSpeed * 0.9);

    const pose = this.blendPose();

    // A figure-eight: horizontal at half the vertical frequency, which reads as a walk cycle.
    const swayScale = this.swayAmount * (1 - this.adsBlend * 0.75) * 0.02;
    const swayX = Math.sin(this.swayPhase) * swayScale;
    const swayY = Math.sin(this.swayPhase * 2) * swayScale * 0.6;

    this.root.position.set(
      pose.position.x + swayX,
      pose.position.y + swayY + this.kick * KICK_UP,
      pose.position.z - this.kick * KICK_BACK,
    );
    this.root.rotation.set(
      pose.rotation.x - this.kick * KICK_ROLL,
      pose.rotation.y + swayX * 0.6,
      pose.rotation.z + this.kick * 0.04,
    );

    // During a reload the left hand leaves the handguard and drops to the magazine well.
    this.leftArm.position.y = -this.reloadBlend * 0.14;
    this.leftArm.position.z = -this.reloadBlend * 0.1;
    this.leftArm.rotation.x = this.reloadBlend * 0.5;

    this.flash.setEnabled(now < this.flashUntil);
    if (now < this.flashUntil) {
      // Vary the flash size per frame so repeated shots do not look like one static sprite.
      const scale = 0.8 + ((now * 0.37) % 1) * 0.5;
      this.flash.scaling.setAll(scale);
    }
  }

  /** Interpolate between hip, ADS and reload poses. */
  private blendPose(): Pose {
    const t = this.adsBlend;
    const position = new Vector3(
      HIP_POSITION.x + (ADS_POSITION.x - HIP_POSITION.x) * t,
      HIP_POSITION.y + (ADS_POSITION.y - HIP_POSITION.y) * t,
      HIP_POSITION.z + (ADS_POSITION.z - HIP_POSITION.z) * t,
    );
    const rotation = new Vector3(
      HIP_ROTATION.x + (ADS_ROTATION.x - HIP_ROTATION.x) * t,
      HIP_ROTATION.y + (ADS_ROTATION.y - HIP_ROTATION.y) * t,
      HIP_ROTATION.z + (ADS_ROTATION.z - HIP_ROTATION.z) * t,
    );

    // Reload dips the whole assembly down and out of the sight line.
    const r = this.reloadBlend;
    position.y -= r * 0.15;
    position.z -= r * 0.09;
    rotation.x += r * 0.5;
    rotation.z += r * 0.2;

    return { position, rotation };
  }

  dispose(): void {
    this.flash.dispose();
    this.muzzle.dispose();
    for (const part of this.parts) part.dispose();
    this.leftArm.dispose();
    this.root.dispose();
  }
}
