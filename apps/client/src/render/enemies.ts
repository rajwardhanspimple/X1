/**
 * Enemy figures.
 *
 * Two representations, one interface:
 *
 * A loaded glTF character when `apps/client/public/models/soldier.glb` exists, driven by the model's
 * own animation clips. Better in every way, and the reason the loader exists.
 *
 * The procedural humanoid rig when it does not. A fresh clone has no binaries, so this path has to
 * work: falling back is not a degraded mode, it is the default until someone runs the fetch script.
 *
 * Both share the pooling and the public methods, so main never branches on which is active.
 *
 * Four decisions worth noting:
 *
 * Figures are pooled by entity id. Creating meshes mid-round is the most reliable way to produce a
 * frame spike in Babylon, and a wave spawns up to seven at once.
 *
 * Locomotion playback rate is tied to measured movement. A fixed-rate walk cycle on a figure moving
 * at a different speed makes the feet slide, which is the most obvious animation error there is. The
 * procedural path solves the same problem by advancing its phase with distance travelled.
 *
 * The weapon is parented to the right hand (procedural) or to a hand bone (glTF). Parenting to the
 * chest is simpler but the gun visibly floats during the arm swing.
 *
 * Death detaches the figure from the live set. The simulation removes a dead entity immediately,
 * which is right for gameplay, but a body that blinks out reads as a bug.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
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
import {
  instantiateCharacter,
  playClip,
  setClipSpeed,
  type CharacterInstance,
  type LoadedCharacter,
} from './character-loader.js';

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
/** Speed in units per second above which the run clip replaces the walk clip. */
const RUN_THRESHOLD = 4.2;

interface Figure {
  /** Common root, positioned by the renderer. */
  root: TransformNode;
  /** Set when this figure uses the procedural rig. */
  rig: HumanoidRig | null;
  /** Set when this figure uses a loaded glTF character. */
  character: CharacterInstance | null;
  /** Every mesh, for fades and shadow registration. */
  meshes: AbstractMesh[];
  /** Meshes that take the archetype colour. Empty for glTF figures, which keep their materials. */
  skinMeshes: AbstractMesh[];
  muzzle: TransformNode;
  flash: Mesh;
  /** Procedural walk cycle phase, advanced by distance travelled. */
  phase: number;
  lastX: number;
  lastZ: number;
  flinchUntil: number;
  flashUntil: number;
  archetype: number;
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
    /** Loaded glTF character, or null to use procedural figures. */
    private model: LoadedCharacter | null = null,
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

  /** True when figures come from a loaded model rather than primitives. */
  usingModel(): boolean {
    return this.model !== null;
  }

  /**
   * Attach a model after construction.
   *
   * Loading is async and the renderer is built synchronously, so the first frames may use procedural
   * figures and switch once the file arrives. Pooled figures are discarded so the next spawn uses
   * the model; live ones are left alone rather than swapped mid-round, which would be jarring.
   */
  setModel(model: LoadedCharacter | null): void {
    if (this.model === model) return;
    this.model = model;
    for (const figure of this.pool) this.destroy(figure);
    this.pool.length = 0;
  }

  /** Change procedural detail level. No effect on glTF figures, whose geometry is fixed. */
  setDetail(detail: RigDetail): void {
    if (this.detail === detail) return;
    this.detail = detail;
    if (this.model) return;
    for (const figure of this.pool) this.destroy(figure);
    this.pool.length = 0;
  }

  /** Build the muzzle marker and flash, shared by both representations. */
  private attachMuzzle(figure: Figure, parent: TransformNode, forward: number): void {
    figure.muzzle.parent = parent;
    figure.muzzle.position.set(0.16, 1.32, forward);

    figure.flash.parent = figure.muzzle;
    figure.flash.billboardMode = 7;
    figure.flash.isPickable = false;
    figure.flash.setEnabled(false);
  }

  private buildProcedural(): Figure {
    const id = `enemy-${this.built++}`;
    const seg = this.detail === 'high' ? 12 : 8;

    const root = new TransformNode(`enemy-root-${id}`, this.scene);
    const rig = buildHumanoid(
      this.scene,
      id,
      { skin: this.skinMaterials[0]!, dark: this.darkMaterial, accent: this.accentMaterial },
      this.detail,
    );
    rig.root.parent = root;

    const weapon = new TransformNode(`${id}-weapon`, this.scene);
    weapon.parent = rig.handRight;
    weapon.position.set(0, -RIG.handLength * 0.5, 0.06);

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
      root,
      rig,
      character: null,
      meshes: rig.meshes,
      skinMeshes: rig.skinMeshes,
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

  private buildFromModel(model: LoadedCharacter): Figure {
    const id = `enemy-${this.built++}`;
    const root = new TransformNode(`enemy-root-${id}`, this.scene);
    const character = instantiateCharacter(model, this.scene, id, 1.8);
    character.root.parent = root;

    /*
     * The model brings its own weapon if the artist included one, so no geometry is added. The muzzle
     * marker is placed at a plausible offset from the body rather than on a hand bone: bone names
     * vary per model, and a wrong guess puts the flash inside the chest. Good enough for a flash that
     * lives 55 ms.
     */
    const muzzle = new TransformNode(`${id}-muzzle`, this.scene);
    const flash = MeshBuilder.CreatePlane(`${id}-flash`, { size: 0.3 }, this.scene);
    flash.material = this.muzzleMaterial;

    const figure: Figure = {
      root,
      rig: null,
      character,
      meshes: character.meshes,
      // glTF figures keep the artist's materials; tinting them would fight the model's own look.
      skinMeshes: [],
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
    this.attachMuzzle(figure, root, 0.55);
    return figure;
  }

  private destroy(figure: Figure): void {
    figure.flash.dispose();
    figure.muzzle.dispose();
    figure.character?.dispose();
    figure.rig?.root.dispose(false, true);
    figure.root.dispose(false, true);
  }

  /** Meshes that should cast shadows, for the shadow generator to register. */
  shadowCasters(): Mesh[] {
    const all: Mesh[] = [];
    const collect = (figure: Figure) => {
      for (const mesh of figure.meshes) {
        // Only real meshes can cast; instanced nodes report as AbstractMesh.
        if ('geometry' in mesh) all.push(mesh as Mesh);
      }
    };
    for (const figure of this.active.values()) collect(figure);
    for (const figure of this.pool) collect(figure);
    return all;
  }

  /** Tint the identifying meshes. A no-op for glTF figures, which keep their own materials. */
  private applySkin(figure: Figure, mode: 'normal' | 'damaged' | 'flash'): void {
    if (figure.skinMeshes.length === 0) return;
    const index = figure.archetype % this.skinMaterials.length;
    const material =
      mode === 'flash'
        ? this.flashMaterial
        : mode === 'damaged'
          ? this.damagedMaterials[index]!
          : this.skinMaterials[index]!;
    for (const mesh of figure.skinMeshes) mesh.material = material;
  }

  private acquire(archetype: number): Figure {
    const figure =
      this.pool.pop() ?? (this.model ? this.buildFromModel(this.model) : this.buildProcedural());

    figure.archetype = archetype;
    figure.flinchUntil = 0;
    figure.flashUntil = 0;
    figure.aimPitch = 0;
    figure.aiming = 0;
    figure.phase = 0;

    if (figure.rig) {
      resetPose(figure.rig);
      poseWeaponGrip(figure.rig, false);
    }
    if (figure.character) {
      figure.character.current = null;
      playClip(figure.character, 'idle', true);
    }
    this.applySkin(figure, 'normal');

    const build = ARCHETYPE_BUILD[archetype % ARCHETYPE_BUILD.length] ?? ARCHETYPE_BUILD[1]!;
    // Non-uniform scale: a heavy is wider as well as taller, which reads as mass.
    figure.root.scaling.set(build.width, build.scale, build.width);
    figure.root.rotation.set(0, 0, 0);
    figure.root.setEnabled(true);
    for (const mesh of figure.meshes) mesh.visibility = 1;
    figure.flash.setEnabled(false);
    return figure;
  }

  private release(figure: Figure): void {
    figure.root.setEnabled(false);
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
    if (figure.rig) figure.rig.spine.rotation.x = -0.16;
    // A one-shot hit clip if the model has one; otherwise the flash carries it.
    if (figure.character) playClip(figure.character, 'hit', false, 1.4);
  }

  /** An enemy fired: flash its muzzle so the player can see where shots came from. */
  onShot(id: number, now: number): void {
    const figure = this.active.get(id);
    if (!figure) return;
    figure.flashUntil = now + MUZZLE_MS;
    if (figure.character) playClip(figure.character, 'shoot', false, 1.2);
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
    // loop: false is essential. A looping death clip makes the corpse stand back up.
    if (figure.character) playClip(figure.character, 'death', false);
    this.corpses.push({ figure, until: now + DEATH_MS, fallYaw: figure.root.rotation.y });
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

    this.updateCorpses(now, dt);
  }

  private place(figure: Figure, enemy: InterpolatedEnemy, now: number, dt: number): void {
    figure.root.position.set(enemy.x, enemy.y, enemy.z);
    figure.root.rotation.y = enemy.yaw * Math.PI * 2;

    // Recover from a hit flinch, then tint by remaining health.
    if (figure.flinchUntil > 0 && now >= figure.flinchUntil) {
      figure.flinchUntil = 0;
      if (figure.rig) figure.rig.spine.rotation.x = 0;
    }
    if (figure.flinchUntil === 0) {
      this.applySkin(figure, enemy.healthFraction < 0.45 ? 'damaged' : 'normal');
    }

    figure.flash.setEnabled(now < figure.flashUntil);

    // Distance travelled this frame, converted to units per second.
    const dx = enemy.x - figure.lastX;
    const dz = enemy.z - figure.lastZ;
    const travelled = Math.sqrt(dx * dx + dz * dz);
    figure.lastX = enemy.x;
    figure.lastZ = enemy.z;
    const speed = dt > 0 ? travelled / dt : 0;

    if (figure.character) {
      this.animateModel(figure, enemy, speed);
    } else if (figure.rig) {
      this.animateProcedural(figure, enemy, travelled, dt);
    }
  }

  /**
   * Drive a glTF figure from its clips.
   *
   * Playback rate is tied to measured speed, which is what prevents sliding feet. The divisors are
   * the speed each clip was authored for; they are estimates, and worth adjusting once a specific
   * model is in use.
   */
  private animateModel(figure: Figure, enemy: InterpolatedEnemy, speed: number): void {
    const character = figure.character!;

    // A one-shot clip is left to finish rather than interrupted every frame.
    const oneShot = character.current === 'shoot' || character.current === 'hit';
    if (oneShot) return;

    if (speed > RUN_THRESHOLD) {
      if (playClip(character, 'run', true)) setClipSpeed(character, speed / 6);
      else if (playClip(character, 'walk', true)) setClipSpeed(character, speed / 2.2);
    } else if (speed > 0.25) {
      if (playClip(character, 'walk', true)) setClipSpeed(character, speed / 2.2);
    } else if (enemy.brain === 2 || enemy.telegraphing) {
      // Standing and engaging: aim if the model has it, otherwise idle.
      if (!playClip(character, 'aim', true)) playClip(character, 'idle', true);
      setClipSpeed(character, 1);
    } else {
      playClip(character, 'idle', true);
      setClipSpeed(character, 1);
    }
  }

  /** Drive the procedural rig by hand. */
  private animateProcedural(
    figure: Figure,
    enemy: InterpolatedEnemy,
    travelled: number,
    dt: number,
  ): void {
    const rig = figure.rig!;
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

    const wantAim = enemy.brain === 2 || enemy.telegraphing ? 1 : 0;
    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);
    const previousAiming = figure.aiming;
    figure.aiming = ease(figure.aiming, wantAim, 8);
    if (Math.abs(figure.aiming - previousAiming) > 0.01) {
      poseWeaponGrip(rig, figure.aiming > 0.5);
    }

    const telegraph = enemy.telegraphing ? 1 : 0;
    figure.aimPitch = ease(figure.aimPitch, telegraph * -0.12, 10);
    rig.neck.rotation.x = figure.aimPitch;
    rig.spine.rotation.x = figure.flinchUntil > 0 ? -0.16 : figure.aimPitch * 0.5;
  }

  /**
   * Advance corpses.
   *
   * A glTF figure plays its own death clip, so only the fade is applied. A procedural one is folded
   * by hand.
   */
  private updateCorpses(now: number, dt: number): void {
    void dt;
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i]!;
      const remaining = (corpse.until - now) / DEATH_MS;
      if (remaining <= 0) {
        this.release(corpse.figure);
        this.corpses.splice(i, 1);
        continue;
      }

      const figure = corpse.figure;
      const progress = 1 - remaining;

      if (figure.rig) {
        const rig = figure.rig;
        // Fall over the first 40%, then hold. Eased, so the body accelerates and settles.
        const fall = Math.min(1, progress * 2.5);
        const eased = 1 - (1 - fall) * (1 - fall);

        figure.root.rotation.x = eased * (Math.PI / 2) * 0.95;
        figure.root.rotation.y = corpse.fallYaw;
        figure.root.position.y = -eased * 0.42;

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
      }

      // Fade over the last 35% so the corpse does not pop out.
      const fade = remaining < 0.35 ? remaining / 0.35 : 1;
      for (const mesh of figure.meshes) mesh.visibility = fade;
    }
  }

  /** World position of an enemy's chest, for impact effects. */
  chestPosition(id: number): Vector3 | null {
    const figure = this.active.get(id);
    if (!figure) return null;
    if (figure.rig) return figure.rig.chest.getAbsolutePosition();
    return figure.root.getAbsolutePosition().add(new Vector3(0, 1.1, 0));
  }

  dispose(): void {
    for (const figure of this.active.values()) this.destroy(figure);
    for (const corpse of this.corpses) this.destroy(corpse.figure);
    for (const figure of this.pool) this.destroy(figure);
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
