/**
 * First-person weapon view model.
 *
 * Built from primitives rather than a loaded asset: the content pipeline does not exist yet
 * (WO-7), and a blocked-out gun that reads clearly is more useful now than a placeholder cube.
 *
 * The whole model is parented to the camera, so it inherits view rotation for free and needs no
 * per-frame transform maths to follow the player's aim. Everything it does on top of that is
 * cosmetic: recoil kick, reload tilt, walk sway, and the ADS pose. None of it is read back into
 * the simulation, so it cannot affect a run or its verification.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';

/** Resting position of the gun in view space: right, down, forward. */
const HIP_POSITION = new Vector3(0.22, -0.2, 0.52);
const HIP_ROTATION = new Vector3(0.02, -0.06, 0);
/** Aiming brings it to centre and closer, which is what sells the sight picture. */
const ADS_POSITION = new Vector3(0, -0.11, 0.38);
const ADS_ROTATION = new Vector3(0, 0, 0);

const KICK_BACK = 0.09;
const KICK_UP = 0.05;
const KICK_ROLL = 0.06;

function material(scene: Scene, name: string, hex: string, emissive = 0): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  m.diffuseColor = colour;
  m.specularColor = new Color3(0.22, 0.22, 0.24);
  m.emissiveColor = colour.scale(emissive);
  return m;
}

export type WeaponKind = 'rifle' | 'smg' | 'pistol';

interface Pose {
  position: Vector3;
  rotation: Vector3;
}

export class WeaponViewModel {
  private readonly root: TransformNode;
  private readonly parts: Mesh[] = [];
  private readonly muzzle: TransformNode;
  private readonly flash: Mesh;

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
    const gripMat = material(scene, 'weapon-grip', '#1c2027');

    // Receiver.
    const body = MeshBuilder.CreateBox(
      'weapon-body',
      { width: 0.075, height: 0.1, depth: 0.42 },
      scene,
    );
    body.position.set(0, 0, 0);
    body.material = bodyMat;
    this.parts.push(body);

    // Barrel, forward and slightly above centre.
    const barrel = MeshBuilder.CreateCylinder(
      'weapon-barrel',
      { diameter: 0.032, height: 0.36, tessellation: 10 },
      scene,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.022, 0.36);
    barrel.material = metalMat;
    this.parts.push(barrel);

    // Handguard over the barrel.
    const guard = MeshBuilder.CreateBox(
      'weapon-guard',
      { width: 0.058, height: 0.055, depth: 0.2 },
      scene,
    );
    guard.position.set(0, 0.012, 0.26);
    guard.material = bodyMat;
    this.parts.push(guard);

    // Magazine, angled forward like a real box mag.
    const mag = MeshBuilder.CreateBox(
      'weapon-mag',
      { width: 0.05, height: 0.16, depth: 0.075 },
      scene,
    );
    mag.position.set(0, -0.115, 0.1);
    mag.rotation.x = -0.12;
    mag.material = gripMat;
    this.parts.push(mag);

    // Pistol grip.
    const grip = MeshBuilder.CreateBox(
      'weapon-grip',
      { width: 0.046, height: 0.14, depth: 0.06 },
      scene,
    );
    grip.position.set(0, -0.105, -0.07);
    grip.rotation.x = 0.3;
    grip.material = gripMat;
    this.parts.push(grip);

    // Stock.
    const stock = MeshBuilder.CreateBox(
      'weapon-stock',
      { width: 0.05, height: 0.085, depth: 0.2 },
      scene,
    );
    stock.position.set(0, -0.012, -0.28);
    stock.material = bodyMat;
    this.parts.push(stock);

    // Rear and front sight posts, so there is something to line up when aiming.
    const rearSight = MeshBuilder.CreateBox(
      'weapon-sight-rear',
      { width: 0.036, height: 0.03, depth: 0.016 },
      scene,
    );
    rearSight.position.set(0, 0.066, 0.02);
    rearSight.material = metalMat;
    this.parts.push(rearSight);

    const frontSight = MeshBuilder.CreateBox(
      'weapon-sight-front',
      { width: 0.014, height: 0.036, depth: 0.014 },
      scene,
    );
    frontSight.position.set(0, 0.062, 0.44);
    frontSight.material = metalMat;
    this.parts.push(frontSight);

    for (const part of this.parts) {
      part.parent = this.root;
      // The gun is very close to the near plane; without this it clips into geometry it overlaps.
      part.renderingGroupId = 1;
      part.isPickable = false;
    }

    // Muzzle marker: where the flash sits and where a tracer appears to start.
    this.muzzle = new TransformNode('weapon-muzzle', scene);
    this.muzzle.parent = this.root;
    this.muzzle.position.set(0, 0.022, 0.55);

    const flashMat = material(scene, 'weapon-flash', '#ffd27f', 2.4);
    flashMat.disableLighting = true;
    this.flash = MeshBuilder.CreatePlane('weapon-flash', { size: 0.22 }, scene);
    this.flash.parent = this.muzzle;
    this.flash.renderingGroupId = 1;
    this.flash.isPickable = false;
    this.flash.material = flashMat;
    this.flash.setEnabled(false);
    // Always face the camera, so a flat plane reads as a burst from any angle.
    this.flash.billboardMode = 7;
  }

  /** World position of the muzzle, for tracer origins. */
  muzzleWorldPosition(): Vector3 {
    return this.muzzle.getAbsolutePosition();
  }

  onShot(now: number): void {
    // Additive, so sustained fire climbs instead of resetting to the same kick each shot.
    this.kick = Math.min(1, this.kick + 0.75);
    this.flashUntil = now + 45;
  }

  onReloadStart(): void {
    this.reloadBlend = 1;
  }

  /**
   * Per-frame update.
   *
   * dt is in seconds, taken from the engine. It only drives easing, so a frame-rate change alters
   * how smooth the animation looks and nothing else.
   */
  update(options: {
    now: number;
    dt: number;
    aiming: boolean;
    reloading: boolean;
    movingSpeed: number;
  }): void {
    const { now, dt, aiming, reloading, movingSpeed } = options;

    // Exponential easing toward the target, framerate independent enough for a view model.
    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);

    this.adsBlend = ease(this.adsBlend, aiming ? 1 : 0, 14);
    this.reloadBlend = ease(this.reloadBlend, reloading ? 1 : 0, 9);
    this.kick = ease(this.kick, 0, 11);

    // Sway follows movement speed and fades out when the player stops.
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

    // Reload dips the gun down and out of the sight line.
    const r = this.reloadBlend;
    position.y -= r * 0.16;
    position.z -= r * 0.1;
    rotation.x += r * 0.55;
    rotation.z += r * 0.22;

    return { position, rotation };
  }

  dispose(): void {
    this.flash.dispose();
    this.muzzle.dispose();
    for (const part of this.parts) part.dispose();
    this.root.dispose();
  }
}
