/**
 * First-person weapon view model, with arms.
 *
 * Built from primitives rather than a loaded asset: the content pipeline does not exist yet
 * (WO-7), and a blocked-out gun that reads clearly is more useful now than a placeholder cube.
 *
 * Three structural decisions:
 *
 * The whole assembly is parented to the camera, and the ARMS are parented to the WEAPON. That
 * ordering is what makes it look like the gun is being held: recoil, sway and the reload tilt move
 * hands and weapon as one object. Parenting them separately produces two things animating near each
 * other, which the eye reads immediately as wrong.
 *
 * The reload is driven by the simulation's own progress fraction rather than a local timer. A local
 * timer would have to assume a duration, and the rifle takes 2.1 s while the pistol takes 1.4 s, so
 * one of them would finish out of step with the ammo actually refilling.
 *
 * Geometry is rounded and tessellated more finely than the enemy figures. This is the most closely
 * inspected geometry in the game: it fills a quarter of the view and never moves away from the
 * camera, so flat faces and square limb ends are obvious here in a way they are not at arena
 * distance. There are only two arms and one weapon on screen, so the vertex cost is affordable.
 *
 * The body poses (slide, Player Down) read the player presentation state that SimulationHost
 * publishes, so this file needs nothing new from main.ts.
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
import { playerPresentation } from './player-presentation.js';

/** Resting position of the assembly in view space: right, down, forward. */
const HIP_POSITION = new Vector3(0.2, -0.22, 0.5);
const HIP_ROTATION = new Vector3(0.03, -0.07, 0);
/** Aiming brings it to centre and closer, which is what sells the sight picture. */
const ADS_POSITION = new Vector3(0, -0.105, 0.36);
const ADS_ROTATION = new Vector3(0, 0, 0);

const KICK_BACK = 0.085;
const KICK_UP = 0.048;
const KICK_ROLL = 0.055;

/** Slide pose: the weapon drops a little, pulls in, and cants toward the lean. */
const SLIDE_DROP = 0.04;
const SLIDE_IN = 0.05;
const SLIDE_CANT = 0.32;
/** Player Down: the weapon falls out of the bottom of the view and is hidden once it is gone. */
const DOWN_DROP = 0.45;
const DOWN_PITCH = 0.9;

/** Higher than the enemy rig: this geometry is centimetres from the camera. */
const SEG = 20;
const SPHERE_SEG = 14;

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
  /** 0 to 1, eased toward whether the player is sliding. */
  private slideBlend = 0;
  /** 0 to 1, eased toward whether the player is down. */
  private downBlend = 0;

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

    const track = (mesh: Mesh): Mesh => {
      this.parts.push(mesh);
      return mesh;
    };

    // --- Weapon ------------------------------------------------------------------------------
    const body = track(
      MeshBuilder.CreateBox('weapon-body', { width: 0.068, height: 0.092, depth: 0.42 }, scene),
    );
    body.material = bodyMat;

    // Barrel tapers slightly toward the muzzle, like an actual barrel with a step down.
    const barrel = track(
      MeshBuilder.CreateCylinder(
        'weapon-barrel',
        { diameterTop: 0.024, diameterBottom: 0.03, height: 0.34, tessellation: SEG },
        scene,
      ),
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.022, 0.35);
    barrel.material = metalMat;

    // Muzzle device: a slightly wider ring at the end, which gives the barrel a termination.
    const muzzleDevice = track(
      MeshBuilder.CreateCylinder(
        'weapon-muzzle-device',
        { diameter: 0.04, height: 0.05, tessellation: SEG },
        scene,
      ),
    );
    muzzleDevice.rotation.x = Math.PI / 2;
    muzzleDevice.position.set(0, 0.022, 0.5);
    muzzleDevice.material = metalMat;

    const guard = track(
      MeshBuilder.CreateCylinder(
        'weapon-guard',
        { diameter: 0.058, height: 0.2, tessellation: SEG },
        scene,
      ),
    );
    guard.rotation.x = Math.PI / 2;
    guard.position.set(0, 0.014, 0.25);
    guard.material = bodyMat;

    /*
     * The magazine is on its own pivot so it can slide out of the well during a reload. It is a
     * real child object rather than something that fades, because seeing the old magazine leave the
     * gun and hit the floor is most of what makes the reload read as mechanical.
     */
    this.magazine = new TransformNode('weapon-mag-pivot', scene);
    this.magazine.parent = this.root;
    this.magazine.position.set(0, -0.112, 0.095);

    this.magazineMesh = track(
      MeshBuilder.CreateCylinder(
        'weapon-mag-mesh',
        {
          diameterTop: 0.058,
          diameterBottom: 0.05,
          height: 0.155,
          tessellation: 6,
        },
        scene,
      ),
    );
    this.magazineMesh.parent = this.magazine;
    this.magazineMesh.rotation.x = -0.12;
    // Squashed on Z so the hexagonal prism reads as a flat box magazine.
    this.magazineMesh.scaling.set(1, 1, 1.24);
    this.magazineMesh.material = this.magMaterial;

    const grip = track(
      MeshBuilder.CreateCylinder(
        'weapon-grip',
        { diameterTop: 0.05, diameterBottom: 0.042, height: 0.135, tessellation: SEG },
        scene,
      ),
    );
    grip.position.set(0, -0.1, -0.07);
    grip.rotation.x = 0.3;
    grip.scaling.z = 1.2;
    grip.material = gripMat;

    const stock = track(
      MeshBuilder.CreateCylinder(
        'weapon-stock',
        { diameterTop: 0.072, diameterBottom: 0.056, height: 0.2, tessellation: SEG },
        scene,
      ),
    );
    stock.rotation.x = Math.PI / 2;
    stock.position.set(0, -0.014, -0.27);
    stock.scaling.x = 0.72;
    stock.material = bodyMat;

    const rearSight = track(
      MeshBuilder.CreateCylinder(
        'weapon-sight-rear',
        { diameter: 0.03, height: 0.028, tessellation: SEG, arc: 0.6 },
        scene,
      ),
    );
    rearSight.position.set(0, 0.066, 0.02);
    rearSight.material = metalMat;

    const frontSight = track(
      MeshBuilder.CreateCylinder(
        'weapon-sight-front',
        { diameter: 0.014, height: 0.036, tessellation: SEG },
        scene,
      ),
    );
    frontSight.position.set(0, 0.062, 0.43);
    frontSight.material = metalMat;

    // --- Right arm: on the grip, with a trigger finger ---------------------------------------
    const rightArm = new TransformNode('weapon-arm-r', scene);
    rightArm.parent = this.root;

    // Forearm tapers from elbow to wrist, running back and down toward the off-screen shoulder.
    const rightForearm = track(
      MeshBuilder.CreateCylinder(
        'weapon-forearm-r',
        { diameterTop: 0.075, diameterBottom: 0.095, height: 0.3, tessellation: SEG },
        scene,
      ),
    );
    rightForearm.parent = rightArm;
    rightForearm.position.set(0.035, -0.17, -0.22);
    rightForearm.rotation.set(Math.PI / 2 + 0.42, -0.1, 0);
    rightForearm.material = sleeveMat;

    // Wrist ball, so the forearm and hand read as connected.
    const rightWrist = track(
      MeshBuilder.CreateSphere('weapon-wrist-r', { diameter: 0.082, segments: SPHERE_SEG }, scene),
    );
    rightWrist.parent = rightArm;
    rightWrist.position.set(0.024, -0.112, -0.11);
    rightWrist.material = gloveMat;

    const rightHand = track(
      MeshBuilder.CreateSphere('weapon-hand-r', { diameter: 0.1, segments: SPHERE_SEG }, scene),
    );
    rightHand.parent = rightArm;
    rightHand.position.set(0.012, -0.075, -0.055);
    rightHand.scaling.set(0.82, 1.05, 0.92);
    rightHand.material = gloveMat;

    // Knuckles wrapping the grip. Four small spheres read as fingers without modelling fingers.
    for (let i = 0; i < 4; i++) {
      const knuckle = track(
        MeshBuilder.CreateSphere(`weapon-knuckle-r-${i}`, { diameter: 0.03, segments: 6 }, scene),
      );
      knuckle.parent = rightArm;
      knuckle.position.set(0.006, -0.048 - i * 0.026, -0.03 + i * 0.006);
      knuckle.material = gloveMat;
    }

    // Trigger finger, forward of the hand. A small detail, but it is what makes the grip read.
    const trigger = track(
      MeshBuilder.CreateCylinder(
        'weapon-finger-r',
        { diameter: 0.024, height: 0.052, tessellation: 8 },
        scene,
      ),
    );
    trigger.parent = rightArm;
    trigger.rotation.x = Math.PI / 2;
    trigger.position.set(0.012, -0.042, -0.012);
    trigger.material = gloveMat;

    // --- Left arm: wrapped over the handguard ------------------------------------------------
    this.leftArm = new TransformNode('weapon-arm-l', scene);
    this.leftArm.parent = this.root;

    const leftForearm = track(
      MeshBuilder.CreateCylinder(
        'weapon-forearm-l',
        { diameterTop: 0.072, diameterBottom: 0.092, height: 0.28, tessellation: SEG },
        scene,
      ),
    );
    leftForearm.parent = this.leftArm;
    leftForearm.position.set(-0.1, -0.14, 0.12);
    leftForearm.rotation.set(Math.PI / 2 + 0.62, 0.34, 0);
    leftForearm.material = sleeveMat;

    const leftWrist = track(
      MeshBuilder.CreateSphere('weapon-wrist-l', { diameter: 0.078, segments: SPHERE_SEG }, scene),
    );
    leftWrist.parent = this.leftArm;
    leftWrist.position.set(-0.052, -0.088, 0.19);
    leftWrist.material = gloveMat;

    const leftHand = track(
      MeshBuilder.CreateSphere('weapon-hand-l', { diameter: 0.098, segments: SPHERE_SEG }, scene),
    );
    leftHand.parent = this.leftArm;
    leftHand.position.set(-0.022, -0.058, 0.245);
    leftHand.scaling.set(0.94, 0.86, 1.02);
    leftHand.material = gloveMat;

    // Fingers curling over the top of the handguard.
    for (let i = 0; i < 4; i++) {
      const finger = track(
        MeshBuilder.CreateSphere(`weapon-finger-l-${i}`, { diameter: 0.028, segments: 6 }, scene),
      );
      finger.parent = this.leftArm;
      finger.position.set(0.004 - i * 0.002, -0.016, 0.208 + i * 0.026);
      finger.material = gloveMat;
    }

    const leftThumb = track(
      MeshBuilder.CreateCylinder(
        'weapon-thumb-l',
        { diameter: 0.024, height: 0.052, tessellation: 8 },
        scene,
      ),
    );
    leftThumb.parent = this.leftArm;
    leftThumb.rotation.z = Math.PI / 2;
    leftThumb.position.set(-0.03, -0.03, 0.252);
    leftThumb.material = gloveMat;

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
      const mesh = MeshBuilder.CreateCylinder(
        `weapon-mag-dropped-${i}`,
        { diameterTop: 0.058, diameterBottom: 0.05, height: 0.155, tessellation: 6 },
        scene,
      );
      mesh.scaling.set(1, 1, 1.24);
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
    const { now, dt, aiming, movingSpeed } = options;
    const sliding = playerPresentation.sliding;
    const down = playerPresentation.downTicks > 0;
    // While down the weapon is out of view, so a reload in progress is not drawn or heard.
    const reloadProgress = down ? 0 : options.reloadProgress;

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
    // Aiming is impossible mid-reload, mid-slide or while down, so the ADS blend is forced down.
    this.adsBlend = ease(this.adsBlend, aiming && !reloading && !sliding && !down ? 1 : 0, 14);
    this.kick = ease(this.kick, 0, 11);
    this.slideBlend = ease(this.slideBlend, sliding ? 1 : 0, sliding ? 12 : 7);
    // Falls slower than it comes back, so going down reads as a collapse and respawn as a snap to ready.
    this.downBlend = ease(this.downBlend, down ? 1 : 0, down ? 5 : 9);

    // A slide is a glide, not a stride, so the walk sway nearly stops.
    const swayTarget = sliding ? 0.15 : Math.min(1, movingSpeed / 7);
    this.swayAmount = ease(this.swayAmount, swayTarget, 6);
    this.swayPhase += dt * (4 + movingSpeed * 0.9);

    const pose = this.blendPose();

    // A figure-eight: horizontal at half the vertical frequency, which reads as a walk cycle.
    const swayScale = this.swayAmount * (1 - this.adsBlend * 0.75) * 0.02;
    const swayX = Math.sin(this.swayPhase) * swayScale;
    const swayY = Math.sin(this.swayPhase * 2) * swayScale * 0.6;

    const slide = this.slideBlend;
    const fall = this.downBlend;

    this.root.position.set(
      pose.position.x + swayX + 0.03 * slide,
      pose.position.y + swayY + this.kick * KICK_UP - SLIDE_DROP * slide - DOWN_DROP * fall,
      pose.position.z - this.kick * KICK_BACK - SLIDE_IN * slide,
    );
    this.root.rotation.set(
      pose.rotation.x - this.kick * KICK_ROLL + 0.1 * slide + DOWN_PITCH * fall,
      pose.rotation.y + swayX * 0.6 - 0.12 * slide,
      pose.rotation.z + this.kick * 0.04 + SLIDE_CANT * slide,
    );
    // Hidden once it has left the view, so it cannot poke into a low camera on the floor.
    this.root.setEnabled(fall < 0.97);

    this.applyReloadPose(reloadProgress);
    this.updateDropped(now, dt);

    this.flash.setEnabled(now < this.flashUntil);
    if (now < this.flashUntil) {
      // Vary the flash size per frame so repeated shots do not look like one static sprite.
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
