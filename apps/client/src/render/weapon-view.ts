/**
 * First-person weapon view model, with arms and a staged reload.
 *
 * Built from primitives rather than a loaded asset: the content pipeline does not exist yet
 * (WO-7), and a blocked-out gun that reads clearly is more useful now than a placeholder cube.
 *
 * Two structural decisions:
 *
 * The whole assembly is parented to the camera, and the ARMS are parented to the WEAPON. That
 * ordering is what makes it look like the gun is being held: recoil, sway and the reload tilt move
 * hands and weapon as one object. Parenting them separately produces two things animating near each
 * other, which the eye reads immediately as wrong.
 *
 * The reload is driven by the simulation's own progress fraction rather than a local timer. A local
 * timer would have to assume a duration, and the rifle takes 2.1 s while the pistol takes 1.4 s, so
 * one of them would finish out of step with the ammo actually refilling. Driving off progress also
 * means a pause mid-reload cannot desync the animation.
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

/**
 * Reload stage boundaries as fractions of the total reload time. Chosen so the mechanical beats
 * (magazine out, magazine in, seat) land at points that feel right regardless of total duration.
 */
const STAGE = {
  release: 0.12,
  extract: 0.3,
  drop: 0.45,
  fetch: 0.68,
  insert: 0.82,
} as const;

export type ReloadStage = 'idle' | 'release' | 'extract' | 'drop' | 'fetch' | 'insert' | 'seat';

function material(scene: Scene, name: string, hex: string, emissive = 0): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  m.diffuseColor = colour;
  m.specularColor = new Color3(0.22, 0.22, 0.24);
  m.specularPower = 52;
  m.emissiveColor = colour.scale(emissive);
  return m;
}

/** Smoothstep, so a stage eases in and out rather than moving linearly. */
function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** Normalise a progress value to 0..1 within one stage window. */
function within(progress: number, from: number, to: number): number {
  if (to <= from) return 0;
  return Math.max(0, Math.min(1, (progress - from) / (to - from)));
}

interface Pose {
  position: Vector3;
  rotation: Vector3;
}

/** A magazine that has been dropped and is falling. */
interface DroppedMag {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  until: number;
}

export class WeaponViewModel {
  private readonly root: TransformNode;
  private readonly parts: Mesh[] = [];
  private readonly muzzle: TransformNode;
  private readonly flash: Mesh;
  /** Left arm pivot, moved through the reload stages. */
  private readonly leftArm: TransformNode;
  /** The magazine in the weapon, moved during extract and insert. */
  private readonly magazine: TransformNode;
  private readonly magazineMesh: Mesh;
  private readonly magMaterial: StandardMaterial;

  /** Dropped magazines, falling under their own gravity. Pooled at three, which is ample. */
  private readonly dropped: DroppedMag[] = [];

  /** Smoothed values, so a pose change eases rather than snapping. */
  private adsBlend = 0;
  private kick = 0;
  private swayPhase = 0;
  private swayAmount = 0;
  private flashUntil = 0;

  /** Reload state, driven by the simulation's progress fraction. */
  private reloadProgress = 0;
  private stage: ReloadStage = 'idle';
  /** Set when a stage boundary is crossed, so the caller can play the matching sound. */
  private stageJustEntered: ReloadStage | null = null;

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
    this.magMaterial = material(scene, 'weapon-mag', '#232830');
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

    /*
     * The magazine is on its own pivot so it can slide out of the well during a reload. It is a
     * real child object rather than something that fades, because seeing the old magazine leave the
     * gun and hit the floor is most of what makes the reload read as mechanical.
     */
    this.magazine = new TransformNode('weapon-mag-pivot', scene);
    this.magazine.parent = this.root;
    this.magazine.position.set(0, -0.112, 0.095);

    this.magazineMesh = MeshBuilder.CreateBox(
      'weapon-mag-mesh',
      { width: 0.048, height: 0.155, depth: 0.072 },
      scene,
    );
    this.magazineMesh.parent = this.magazine;
    this.magazineMesh.rotation.x = -0.12;
    this.magazineMesh.material = this.magMaterial;
    this.parts.push(this.magazineMesh);

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

    const trigger = MeshBuilder.CreateBox(
      'weapon-finger-r',
      { width: 0.022, height: 0.022, depth: 0.05 },
      scene,
    );
    trigger.parent = rightArm;
    trigger.position.set(0.012, -0.042, -0.015);
    trigger.material = gloveMat;
    this.parts.push(trigger);

    // --- Left arm: wrapped over the handguard, and the reload hand ---------------------------
    this.leftArm = new TransformNode('weapon-arm-l', scene);
    this.leftArm.parent = this.root;

    const leftForearm = MeshBuilder.CreateBox(
      'weapon-forearm-l',
      { width: 0.082, height: 0.082, depth: 0.28 },
      scene,
    );
    leftForearm.parent = this.leftArm;
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

    // Dropped magazines live in world space, so they are not in the weapon's rendering group.
    for (let i = 0; i < 3; i++) {
      const mesh = MeshBuilder.CreateBox(
        `weapon-mag-dropped-${i}`,
        { width: 0.048, height: 0.155, depth: 0.072 },
        scene,
      );
      mesh.material = this.magMaterial;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.dropped.push({
        mesh,
        velocity: new Vector3(),
        spin: new Vector3(),
        until: 0,
      });
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

  /**
   * Stage entered on this frame, consumed once. The caller plays the matching sound, so audio and
   * animation cannot drift: both are driven by the same progress value.
   */
  consumeStageChange(): ReloadStage | null {
    const stage = this.stageJustEntered;
    this.stageJustEntered = null;
    return stage;
  }

  private stageFor(progress: number): ReloadStage {
    if (progress <= 0) return 'idle';
    if (progress < STAGE.release) return 'release';
    if (progress < STAGE.extract) return 'extract';
    if (progress < STAGE.drop) return 'drop';
    if (progress < STAGE.fetch) return 'fetch';
    if (progress < STAGE.insert) return 'insert';
    return 'seat';
  }

  /** Release a magazine into the world so it falls away from the gun. */
  private dropMagazine(now: number): void {
    // Reuse the oldest slot. Three is enough that a visible one is never recycled early.
    let slot = this.dropped[0]!;
    for (const candidate of this.dropped) {
      if (candidate.until < slot.until) slot = candidate;
    }

    slot.mesh.position.copyFrom(this.magazine.getAbsolutePosition());
    slot.mesh.rotationQuaternion = null;
    slot.mesh.rotation.set(Math.random() * 0.6, Math.random() * 0.6, Math.random() * 0.6);
    // Falls down and slightly away from the player, with a tumble.
    slot.velocity.set((Math.random() - 0.5) * 0.5, -0.4, (Math.random() - 0.5) * 0.4);
    slot.spin.set(
      (Math.random() * 2 - 1) * 6,
      (Math.random() * 2 - 1) * 6,
      (Math.random() * 2 - 1) * 6,
    );
    slot.mesh.visibility = 1;
    slot.mesh.setEnabled(true);
    slot.until = now + 2200;
  }

  /**
   * Per-frame update. dt is in seconds and only drives easing, so a frame-rate change alters how
   * smooth the animation looks and nothing else.
   */
  update(options: {
    now: number;
    dt: number;
    aiming: boolean;
    /** 0 to 1 through the reload, from the simulation. 0 when not reloading. */
    reloadProgress: number;
    movingSpeed: number;
  }): void {
    const { now, dt, aiming, reloadProgress, movingSpeed } = options;

    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);

    // Track stage transitions by crossing a threshold, not by counting time, so a pause cannot
    // desync the animation from the simulation.
    const nextStage = this.stageFor(reloadProgress);
    if (nextStage !== this.stage) {
      this.stage = nextStage;
      this.stageJustEntered = nextStage;
      if (nextStage === 'drop') this.dropMagazine(now);
    }
    this.reloadProgress = reloadProgress;

    const reloading = reloadProgress > 0;
    // Aiming is impossible mid-reload, so the ADS blend is forced down rather than fought over.
    this.adsBlend = ease(this.adsBlend, aiming && !reloading ? 1 : 0, 14);
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

    this.applyReloadPose(reloadProgress);
    this.updateDropped(now, dt);

    this.flash.setEnabled(now < this.flashUntil);
    if (now < this.flashUntil) {
      const scale = 0.8 + ((now * 0.37) % 1) * 0.5;
      this.flash.scaling.setAll(scale);
    }
  }

  /**
   * Move the magazine and the left hand through the reload stages.
   *
   * Each stage is a window in the progress fraction, so the whole sequence stretches or compresses
   * to whatever duration the weapon has.
   */
  private applyReloadPose(progress: number): void {
    if (progress <= 0) {
      // Ready position: magazine seated, left hand on the handguard.
      this.magazine.position.set(0, -0.112, 0.095);
      this.magazineMesh.visibility = 1;
      this.leftArm.position.setAll(0);
      this.leftArm.rotation.setAll(0);
      return;
    }

    // Left hand: on the handguard, then down to the magazine well, off-screen, and back.
    let handY = 0;
    let handZ = 0;
    let handX = 0;
    let handPitch = 0;

    // Magazine: seated, sliding out, gone, then rising back in.
    let magY = -0.112;
    let magZ = 0.095;
    let magVisible = true;

    if (progress < STAGE.release) {
      // Release: the hand comes off the handguard and reaches for the magazine.
      const t = smooth(within(progress, 0, STAGE.release));
      handY = -0.1 * t;
      handZ = -0.16 * t;
      handPitch = 0.42 * t;
    } else if (progress < STAGE.extract) {
      // Extract: the magazine slides down and out, the hand travelling with it.
      const t = smooth(within(progress, STAGE.release, STAGE.extract));
      handY = -0.1 - 0.12 * t;
      handZ = -0.16 - 0.02 * t;
      handPitch = 0.42 + 0.1 * t;
      magY = -0.112 - 0.16 * t;
      magZ = 0.095 - 0.02 * t;
    } else if (progress < STAGE.drop) {
      // Drop: the old magazine is now a separate falling object, so the weapon's one is hidden.
      const t = smooth(within(progress, STAGE.extract, STAGE.drop));
      handY = -0.22 - 0.16 * t;
      handZ = -0.18;
      handPitch = 0.52;
      magVisible = false;
    } else if (progress < STAGE.fetch) {
      // Fetch: the hand goes low off-screen and comes back up with a fresh magazine.
      const t = within(progress, STAGE.drop, STAGE.fetch);
      // Down for the first half, up for the second, so it reads as reaching to a pouch.
      const dip = t < 0.5 ? smooth(t * 2) : 1 - smooth((t - 0.5) * 2);
      handY = -0.38 - 0.16 * dip;
      handZ = -0.18 + 0.04 * dip;
      handX = -0.05 * dip;
      handPitch = 0.52 + 0.3 * dip;
      magVisible = false;
    } else if (progress < STAGE.insert) {
      // Insert: the fresh magazine rises into the well.
      const t = smooth(within(progress, STAGE.fetch, STAGE.insert));
      handY = -0.38 + 0.26 * t;
      handZ = -0.18 + 0.02 * t;
      handPitch = 0.52 - 0.1 * t;
      magY = -0.3 + 0.188 * t;
      magZ = 0.075 + 0.02 * t;
    } else {
      /*
       * Seat and present. The magazine overshoots slightly and settles, which reads as a firm slap,
       * and the hand returns to the handguard.
       */
      const t = smooth(within(progress, STAGE.insert, 1));
      const overshoot = Math.sin(t * Math.PI) * 0.012;
      handY = -0.12 * (1 - t);
      handZ = -0.16 * (1 - t);
      handPitch = 0.42 * (1 - t);
      magY = -0.112 - overshoot;
      magZ = 0.095;
    }

    this.leftArm.position.set(handX, handY, handZ);
    this.leftArm.rotation.x = handPitch;
    this.magazine.position.set(0, magY, magZ);
    this.magazineMesh.visibility = magVisible ? 1 : 0;
  }

  /** Dropped magazines fall, tumble and fade. */
  private updateDropped(now: number, dt: number): void {
    const step = Math.min(0.05, dt);
    for (const mag of this.dropped) {
      if (mag.until === 0) continue;
      if (now >= mag.until) {
        mag.mesh.setEnabled(false);
        mag.until = 0;
        continue;
      }
      mag.velocity.y -= 9.5 * step;
      mag.mesh.position.addInPlace(mag.velocity.scale(step));
      mag.mesh.rotation.x += mag.spin.x * step;
      mag.mesh.rotation.y += mag.spin.y * step;
      mag.mesh.rotation.z += mag.spin.z * step;

      // Settle on the floor rather than falling through it.
      if (mag.mesh.position.y <= 0.08) {
        mag.mesh.position.y = 0.08;
        mag.velocity.setAll(0);
        mag.spin.scaleInPlace(0.85);
      }

      const remaining = mag.until - now;
      mag.mesh.visibility = remaining < 500 ? remaining / 500 : 1;
    }
  }

  /** Interpolate between hip and ADS poses, then add the reload tilt. */
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

    /*
     * The reload tilt peaks in the middle of the sequence and returns by the end, so the weapon is
     * brought in to work on and then presented again. A constant offset for the whole reload would
     * make the gun snap back to ready the instant the timer expired.
     */
    if (this.reloadProgress > 0) {
      const arc = Math.sin(Math.min(1, this.reloadProgress) * Math.PI);
      position.x += arc * 0.05;
      position.y -= arc * 0.13;
      position.z -= arc * 0.07;
      rotation.x += arc * 0.46;
      rotation.y -= arc * 0.3;
      rotation.z += arc * 0.22;
    }

    return { position, rotation };
  }

  dispose(): void {
    for (const mag of this.dropped) mag.mesh.dispose();
    this.dropped.length = 0;
    this.flash.dispose();
    this.muzzle.dispose();
    for (const part of this.parts) part.dispose();
    this.magazine.dispose();
    this.leftArm.dispose();
    this.magMaterial.dispose();
    this.root.dispose();
  }
}
