/**
 * Enemy figures.
 *
 * Built on the shared humanoid rig, so proportions match the player's own arms and a change in one
 * place applies to both.
 *
 * Five decisions worth noting:
 *
 * Figures are pooled by entity id. Creating and disposing meshes mid-round is the most reliable way
 * to produce a frame spike in Babylon, and a wave spawns up to seven at once.
 *
 * The walk cycle is driven by distance travelled, not a timer. A timer-driven cycle keeps marching
 * when the figure stops, which reads as broken; advancing by actual movement means the legs match
 * the speed and stop dead on stopping. Knees bend on the return stroke only, which is what makes it
 * read as walking rather than as a pendulum.
 *
 * The weapon is parented to the right hand, with the left hand posed onto the handguard. Parenting
 * it to the chest instead would be simpler but the gun would visibly float during the arm swing.
 *
 * Death detaches the figure from the live set. The simulation removes a dead entity immediately,
 * which is correct for gameplay, but a body that blinks out reads as a bug; detaching lets the
 * corpse finish collapsing while the sim moves on.
 *
 * Detail level comes from the quality tier. Rounded geometry is expensive, so Low builds the same
 * figure at half the radial segments: still recognisably a person, at a fraction of the vertices.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { InterpolatedEnemy, InterpolatedFrame } from './interpolator.js';
import {
  buildHumanoid,
  poseWeaponGrip,
  resetPose,
  RIG,
  type HumanoidRig,
  type RigDetail,
} from './humanoid.js';

const ARCHETYPE_COLOURS = ['#e0644f', '#e0a94f', '#b44fe0'];
/** Rushers are lean, riflemen standard, heavies bulky. Applied as non-uniform scale. */
const ARCHETYPE_BUILD = [
  { scale: 0.96, width: 0.92 },
  { scale: 1, width: 1 },
  { scale: 1.1, width: 1.22 },
];

const FLINCH_MS = 120;
const DEATH_MS = 1100;
const MUZZLE_MS = 55;

interface Figure {
  rig: HumanoidRig;
  weapon: TransformNode;
  muzzle: TransformNode;
  flash: Mesh;
  /** Walk cycle phase, advanced by distance travelled. */
  phase: number;
  lastX: number;
  lastZ: number;
  flinchUntil: number;
  flashUntil: number;
  archetype: number;
  /** Smoothed aim pitch, so the head and chest track rather than snap. */
  aimPitch: number;
  aiming: number;
}

interface Corpse {
  figure: Figure;
  until: number;
  fallYaw: number;
}

export class EnemyRenderer {
  private readonly pool: Figure[] = [];
  private readonly active = new Map<number, Figure>();
  private readonly corpses: Corpse[] = [];
  private readonly skinMaterials: StandardMaterial[] = [];
  private readonly damagedMaterials: StandardMaterial[] = [];
  private readonly flashMaterial: StandardMaterial;
  private readonly darkMaterial: StandardMaterial;
  private readonly accentMaterial: StandardMaterial;
  private readonly weaponMaterial: StandardMaterial;
  private readonly muzzleMaterial: StandardMaterial;
  private built = 0;

  constructor(
    private readonly scene: Scene,
    private detail: RigDetail = 'high',
  ) {
    for (let i = 0; i < ARCHETYPE_COLOURS.length; i++) {
      const colour = Color3.FromHexString(ARCHETYPE_COLOURS[i]!);

      const skin = new StandardMaterial(`enemy-skin-${i}`, scene);
      skin.diffuseColor = colour;
      skin.emissiveColor = colour.scale(0.16);
      skin.specularColor = new Color3(0.14, 0.14, 0.16);
      skin.specularPower = 40;
      this.skinMaterials.push(skin);

      // A darker variant for a wounded figure, so damage is readable at a glance.
      const damaged = new StandardMaterial(`enemy-damaged-${i}`, scene);
      damaged.diffuseColor = colour.scale(0.45);
      damaged.emissiveColor = colour.scale(0.06);
      damaged.specularColor = new Color3(0.08, 0.08, 0.1);
      this.damagedMaterials.push(damaged);
    }

    // A hit flashes the body to near-white, which reads instantly at any distance or colour.
    this.flashMaterial = new StandardMaterial('enemy-flash', scene);
    this.flashMaterial.diffuseColor = Color3.White();
    this.flashMaterial.emissiveColor = new Color3(0.9, 0.9, 0.9);

    this.darkMaterial = new StandardMaterial('enemy-dark', scene);
    this.darkMaterial.diffuseColor = Color3.FromHexString('#1e222c');
    this.darkMaterial.specularColor = new Color3(0.08, 0.08, 0.1);
    this.darkMaterial.specularPower = 32;

    this.accentMaterial = new StandardMaterial('enemy-accent', scene);
    this.accentMaterial.diffuseColor = Color3.FromHexString('#14171f');
    this.accentMaterial.emissiveColor = Color3.FromHexString('#2a3242').scale(0.4);

    this.weaponMaterial = new StandardMaterial('enemy-weapon', scene);
    this.weaponMaterial.diffuseColor = Color3.FromHexString('#33394a');
    this.weaponMaterial.specularColor = new Color3(0.24, 0.24, 0.26);
    this.weaponMaterial.specularPower = 56;

    this.muzzleMaterial = new StandardMaterial('enemy-muzzle', scene);
    this.muzzleMaterial.emissiveColor = Color3.FromHexString('#ffd27f').scale(2.2);
    this.muzzleMaterial.diffuseColor = Color3.Black();
    this.muzzleMaterial.disableLighting = true;
  }

  /**
   * Change detail level. Existing figures are discarded so the next wave rebuilds at the new count;
   * rebuilding live figures mid-round would stutter for no visual gain.
   */
  setDetail(detail: RigDetail): void {
    if (this.detail === detail) return;
    this.detail = detail;
    for (const figure of this.pool) figure.rig.root.dispose(false, true);
    this.pool.length = 0;
  }

  private build(): Figure {
    const id = `enemy-${this.built++}`;
    const seg = this.detail === 'high' ? 12 : 8;

    const rig = buildHumanoid(
      this.scene,
      id,
      {
        skin: this.skinMaterials[0]!,
        dark: this.darkMaterial,
        accent: this.accentMaterial,
      },
      this.detail,
    );

    /*
     * The weapon hangs off the right hand. Parenting to the chest would be simpler, but then the
     * gun floats away from the hands during the arm swing, which is immediately noticeable.
     */
    const weapon = new TransformNode(`${id}-weapon`, this.scene);
    weapon.parent = rig.handRight;
    weapon.position.set(0, -RIG.handLength * 0.5, 0.06);

    // Receiver: a rounded box rather than a hard-edged one, to match the figure.
    const body = MeshBuilder.CreateBox(
      `${id}-weapon-body`,
      { width: 0.066, height: 0.086, depth: 0.42 },
      this.scene,
    );
    body.parent = weapon;
    body.material = this.weaponMaterial;
    body.isPickable = false;
    rig.meshes.push(body);

    const barrel = MeshBuilder.CreateCylinder(
      `${id}-weapon-barrel`,
      { diameterTop: 0.026, diameterBottom: 0.032, height: 0.32, tessellation: seg },
      this.scene,
    );
    barrel.parent = weapon;
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.018, 0.33);
    barrel.material = this.weaponMaterial;
    barrel.isPickable = false;
    rig.meshes.push(barrel);

    const guard = MeshBuilder.CreateCylinder(
      `${id}-weapon-guard`,
      { diameter: 0.056, height: 0.19, tessellation: seg },
      this.scene,
    );
    guard.parent = weapon;
    guard.rotation.x = Math.PI / 2;
    guard.position.set(0, 0.012, 0.22);
    guard.material = this.accentMaterial;
    guard.isPickable = false;
    rig.meshes.push(guard);

    const mag = MeshBuilder.CreateBox(
      `${id}-weapon-mag`,
      { width: 0.042, height: 0.13, depth: 0.066 },
      this.scene,
    );
    mag.parent = weapon;
    mag.position.set(0, -0.095, 0.06);
    mag.rotation.x = -0.12;
    mag.material = this.accentMaterial;
    mag.isPickable = false;
    rig.meshes.push(mag);

    const muzzle = new TransformNode(`${id}-muzzle`, this.scene);
    muzzle.parent = weapon;
    muzzle.position.set(0, 0.018, 0.5);

    const flash = MeshBuilder.CreatePlane(`${id}-flash`, { size: 0.3 }, this.scene);
    flash.parent = muzzle;
    flash.material = this.muzzleMaterial;
    flash.billboardMode = 7;
    flash.isPickable = false;
    flash.setEnabled(false);

    return {
      rig,
      weapon,
      muzzle,
      flash,
      phase: 0,
      lastX: 0,
      lastZ: 0,
      flinchUntil: 0,
      flashUntil: 0,
      archetype: 0,
      aimPitch: 0,
      aiming: 0,
    };
  }

  /** Meshes that should cast shadows, for the shadow generator to register. */
  shadowCasters(): Mesh[] {
    const all: Mesh[] = [];
    for (const figure of this.active.values()) all.push(...figure.rig.meshes);
    for (const figure of this.pool) all.push(...figure.rig.meshes);
    return all;
  }

  /** Tint the identifying meshes: normal, wounded, or flashing from a hit. */
  private applySkin(figure: Figure, mode: 'normal' | 'damaged' | 'flash'): void {
    const index = figure.archetype % this.skinMaterials.length;
    const material =
      mode === 'flash'
        ? this.flashMaterial
        : mode === 'damaged'
          ? this.damagedMaterials[index]!
          : this.skinMaterials[index]!;
    for (const mesh of figure.rig.skinMeshes) mesh.material = material;
  }

  private acquire(archetype: number): Figure {
    const figure = this.pool.pop() ?? this.build();
    figure.archetype = archetype;
    figure.flinchUntil = 0;
    figure.flashUntil = 0;
    figure.aimPitch = 0;
    figure.aiming = 0;
    resetPose(figure.rig);
    poseWeaponGrip(figure.rig, false);
    this.applySkin(figure, 'normal');

    const build = ARCHETYPE_BUILD[archetype % ARCHETYPE_BUILD.length] ?? ARCHETYPE_BUILD[1]!;
    // Non-uniform scale: a heavy is wider as well as taller, which reads as mass.
    figure.rig.root.scaling.set(build.width, build.scale, build.width);
    figure.rig.root.setEnabled(true);
    for (const mesh of figure.rig.meshes) mesh.visibility = 1;
    figure.flash.setEnabled(false);
    return figure;
  }

  private release(figure: Figure): void {
    figure.rig.root.setEnabled(false);
    figure.flash.setEnabled(false);
    figure.phase = 0;
    this.pool.push(figure);
  }

  /** Flash a body on hit, so damage is visible before the kill. */
  onHit(id: number, now: number): void {
    const figure = this.active.get(id);
    if (!figure) return;
    figure.flinchUntil = now + FLINCH_MS;
    this.applySkin(figure, 'flash');
    // A backward jolt at the spine reads as impact without disturbing the legs.
    figure.rig.spine.rotation.x = -0.16;
  }

  /** An enemy fired: flash its muzzle so the player can see where shots came from. */
  onShot(id: number, now: number): void {
    const figure = this.active.get(id);
    if (!figure) return;
    figure.flashUntil = now + MUZZLE_MS;
  }

  /**
   * Start a death animation. The figure leaves the live set, so the simulation is free to remove
   * the entity on the same tick while the body finishes collapsing.
   */
  onDeath(id: number, now: number): void {
    const figure = this.active.get(id);
    if (!figure) return;
    this.active.delete(id);
    this.applySkin(figure, 'damaged');
    figure.flash.setEnabled(false);
    this.corpses.push({ figure, until: now + DEATH_MS, fallYaw: figure.rig.root.rotation.y });
  }

  /** Position and animate every living enemy, then advance any corpses. */
  update(frame: InterpolatedFrame, now: number, dt: number): void {
    for (const [id, enemy] of frame.enemies) {
      let figure = this.active.get(id);
      if (!figure) {
        figure = this.acquire(enemy.archetype);
        figure.lastX = enemy.x;
        figure.lastZ = enemy.z;
        this.active.set(id, figure);
      }
      this.place(figure, enemy, now, dt);
    }

    // An entity that left the snapshot without a death event despawned rather than died.
    for (const [id, figure] of this.active) {
      if (!frame.enemies.has(id)) {
        this.release(figure);
        this.active.delete(id);
      }
    }

    this.updateCorpses(now);
  }

  private place(figure: Figure, enemy: InterpolatedEnemy, now: number, dt: number): void {
    const rig = figure.rig;
    rig.root.position.set(enemy.x, enemy.y, enemy.z);
    rig.root.rotation.y = enemy.yaw * Math.PI * 2;

    // Recover from a hit flinch, then tint by remaining health.
    if (figure.flinchUntil > 0 && now >= figure.flinchUntil) {
      figure.flinchUntil = 0;
      rig.spine.rotation.x = 0;
    }
    if (figure.flinchUntil === 0) {
      this.applySkin(figure, enemy.healthFraction < 0.45 ? 'damaged' : 'normal');
    }

    figure.flash.setEnabled(now < figure.flashUntil);

    // Advance the walk cycle by the distance covered since the last frame.
    const dx = enemy.x - figure.lastX;
    const dz = enemy.z - figure.lastZ;
    const travelled = Math.sqrt(dx * dx + dz * dz);
    figure.lastX = enemy.x;
    figure.lastZ = enemy.z;
    figure.phase += travelled * 3.1;

    const swing = Math.sin(figure.phase);
    const amplitude = Math.min(0.72, travelled * 24);

    // Hips swing the thighs.
    rig.hipLeft.rotation.x = swing * amplitude;
    rig.hipRight.rotation.x = -swing * amplitude;

    /*
     * Knees only bend on the backswing. A knee that bends in both directions looks like a puppet;
     * bending only when the leg travels backwards is what a real stride does, and it is the detail
     * that makes the walk legible at a distance.
     */
    rig.kneeLeft.rotation.x = Math.max(0, -swing) * amplitude * 1.5;
    rig.kneeRight.rotation.x = Math.max(0, swing) * amplitude * 1.5;

    // A slight vertical bob and a counter-rotation at the pelvis complete the stride.
    rig.pelvis.position.y = RIG.pelvisY - Math.abs(Math.cos(figure.phase)) * amplitude * 0.045;
    rig.pelvis.rotation.y = swing * amplitude * 0.12;
    // The chest counter-rotates against the hips, which is what stops the torso looking rigid.
    rig.chest.rotation.y = -swing * amplitude * 0.16;

    /*
     * Aim tracking. Engaging or telegraphing raises the weapon; the head and chest pitch toward the
     * player. Eased, so an enemy acquiring a target turns to face rather than snapping.
     */
    const wantAim = enemy.brain === 2 || enemy.telegraphing ? 1 : 0;
    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);
    const previousAiming = figure.aiming;
    figure.aiming = ease(figure.aiming, wantAim, 8);
    // Re-pose the grip when the aim state changes meaningfully, not every frame.
    if (Math.abs(figure.aiming - previousAiming) > 0.01) {
      poseWeaponGrip(rig, figure.aiming > 0.5);
    }

    // Telegraph: the weapon lifts and the whole figure straightens, which is the player's cue.
    const telegraph = enemy.telegraphing ? 1 : 0;
    figure.aimPitch = ease(figure.aimPitch, telegraph * -0.12, 10);
    rig.neck.rotation.x = figure.aimPitch;
    rig.spine.rotation.x = figure.flinchUntil > 0 ? -0.16 : figure.aimPitch * 0.5;
  }

  /** Fold at the knees and spine, topple, sink and fade. */
  private updateCorpses(now: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i]!;
      const remaining = (corpse.until - now) / DEATH_MS;
      if (remaining <= 0) {
        this.release(corpse.figure);
        this.corpses.splice(i, 1);
        continue;
      }
      const progress = 1 - remaining;
      const rig = corpse.figure.rig;
      // Fall over the first 40%, then hold.
      const fall = Math.min(1, progress * 2.5);
      // Ease out, so the body accelerates into the fall and settles.
      const eased = 1 - (1 - fall) * (1 - fall);

      rig.root.rotation.x = eased * (Math.PI / 2) * 0.95;
      rig.root.rotation.y = corpse.fallYaw;
      rig.root.position.y = -eased * 0.42;

      // Knees buckle first, then the spine folds and the limbs go slack.
      rig.kneeLeft.rotation.x = eased * 1.5;
      rig.kneeRight.rotation.x = eased * 1.2;
      rig.hipLeft.rotation.x = -eased * 0.5;
      rig.hipRight.rotation.x = -eased * 0.35;
      rig.spine.rotation.x = eased * 0.45;
      rig.neck.rotation.x = eased * 0.5;
      rig.shoulderLeft.rotation.set(eased * 0.5, 0, -eased * 0.6);
      rig.shoulderRight.rotation.set(eased * 0.4, 0, eased * 0.7);
      rig.elbowLeft.rotation.x = eased * 0.3;
      rig.elbowRight.rotation.x = eased * 0.25;

      // Fade over the last 35% so the corpse does not pop out.
      const fade = remaining < 0.35 ? remaining / 0.35 : 1;
      for (const mesh of rig.meshes) mesh.visibility = fade;
    }
  }

  /** World position of an enemy's chest, for impact effects. */
  chestPosition(id: number): Vector3 | null {
    const figure = this.active.get(id);
    if (!figure) return null;
    return figure.rig.chest.getAbsolutePosition();
  }

  dispose(): void {
    for (const figure of this.active.values()) figure.rig.root.dispose(false, true);
    for (const corpse of this.corpses) corpse.figure.rig.root.dispose(false, true);
    for (const figure of this.pool) figure.rig.root.dispose(false, true);
    this.active.clear();
    this.corpses.length = 0;
    this.pool.length = 0;
    for (const m of this.skinMaterials) m.dispose();
    for (const m of this.damagedMaterials) m.dispose();
    this.flashMaterial.dispose();
    this.darkMaterial.dispose();
    this.accentMaterial.dispose();
    this.weaponMaterial.dispose();
    this.muzzleMaterial.dispose();
  }
}
