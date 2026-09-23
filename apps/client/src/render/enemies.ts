/**
 * Enemy figures.
 *
 * Two representations, one interface:
 *
 * A loaded glTF character when one is available, driven by the model's own animation clips.
 *
 * The procedural humanoid rig when none is. This is the default, because it is the only figure that actually holds a
 * weapon: every model in the catalogue ships body geometry only, so their aim and shoot clips mime with empty hands.
 *
 * Both share the pooling and the public methods, so main never branches on which is active.
 *
 * Four decisions worth noting:
 *
 * Figures are pooled by entity id. Creating meshes mid-round is the most reliable way to produce a frame spike in Babylon,
 * and a wave spawns up to seven at once.
 *
 * Locomotion clips are chosen by movement direction RELATIVE TO FACING, and their playback rate is tied to measured speed.
 * An enemy backing away while playing a forward run slides visibly, and that single mismatch does more to make a figure
 * look wrong than any amount of geometry detail.
 *
 * One-shot clips are allowed to finish, tracked by an EXPIRY rather than by the clip name. Comparing names meant the state
 * never cleared: a figure that flinched once returned early from every subsequent locomotion update and froze for the rest
 * of its life.
 *
 * A figure that leaves the snapshot is held for one frame before being released. main updates the renderer from the
 * snapshot before it drains visual events, so a death event arrives after the entity has already gone; without the grace
 * frame every death was treated as a despawn and no death animation ever played.
 *
 * The procedural rifle is mounted to the chest. Both arm poses are solved against its actual grip
 * positions by bindWeaponGrip. Chest motion is inherited by the rifle and arms together; it does
 * not erase their local joint rotations. Gameplay never reads this presentation pose.
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
  bindWeaponGrip,
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
  playFirstAvailable,
  setClipSpeed,
  type CharacterClip,
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
/** Speed in units per second above which run replaces walk. */
const RUN_THRESHOLD = 4.2;
/** Below this speed a figure counts as standing still. */
const IDLE_THRESHOLD = 0.25;
/** Authored speed of each locomotion clip, for matching playback rate to movement. */
const WALK_CLIP_SPEED = 2.2;
const RUN_CLIP_SPEED = 6;
/** Fallback duration for a one-shot whose clip length cannot be read. */
const DEFAULT_ONE_SHOT_MS = 450;

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
  /**
   * When the current one-shot clip finishes, or 0 when none is playing.
   *
   * An expiry rather than a name comparison. The previous version asked "is the current clip one of the one-shots", which
   * stayed true forever because nothing reset it, so locomotion returned early for the rest of the figure's life.
   */
  oneShotUntil: number;
  archetype: number;
  aimPitch: number;
  aiming: number;
  /** Alternates the two hit reactions, so repeated hits are not identical. */
  hitToggle: boolean;
}

interface Corpse {
  figure: Figure;
  until: number;
  fallYaw: number;
}

export class EnemyRenderer {
  private readonly pool: Figure[] = [];
  private readonly active = new Map<number, Figure>();
  /**
   * Figures whose entity has left the snapshot but which have not been released yet.
   *
   * The grace window exists because main updates this renderer from the snapshot BEFORE draining visual events, so a death
   * event always arrives one step after the entity disappeared. Releasing immediately meant onDeath found nothing and no
   * death animation ever played.
   */
  private readonly leaving = new Map<number, { figure: Figure; since: number }>();
  private readonly corpses: Corpse[] = [];
  private readonly skinMaterials: StandardMaterial[] = [];
  private readonly damagedMaterials: StandardMaterial[] = [];
  private readonly flashMaterial: StandardMaterial;
  private readonly darkMaterial: StandardMaterial;
  private readonly accentMaterial: StandardMaterial;
  private readonly weaponMaterial: StandardMaterial;
  private readonly muzzleMaterial: StandardMaterial;
  private built = 0;
  /**
   * Increments whenever the set of meshes changes.
   *
   * main watches this to re-register shadow casters. The previous version registered once behind a boolean, so every figure
   * built after the first wave cast no shadow and appeared to float.
   */
  private meshGeneration = 0;

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

  /** Changes whenever the mesh set changes, so shadow casters can be re-registered. */
  generation(): number {
    return this.meshGeneration;
  }

  /**
   * Attach a model after construction.
   *
   * Loading is async and the renderer is built synchronously, so the first frames may use procedural figures and switch
   * once the file arrives. Pooled figures are discarded so the next spawn uses the model; live ones are left alone rather
   * than swapped mid-round, which would be jarring.
   */
  setModel(model: LoadedCharacter | null): void {
    if (this.model === model) return;
    this.model = model;
    for (const figure of this.pool) this.destroy(figure);
    this.pool.length = 0;
    this.meshGeneration += 1;
  }

  /** Change procedural detail level. No effect on glTF figures, whose geometry is fixed. */
  setDetail(detail: RigDetail): void {
    if (this.detail === detail) return;
    this.detail = detail;
    if (this.model) return;
    for (const figure of this.pool) this.destroy(figure);
    this.pool.length = 0;
    this.meshGeneration += 1;
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

    // The mount and palm targets share chest space. Bind after creating the weapon geometry.
    const weapon = new TransformNode(`${id}-weapon`, this.scene);
    weapon.parent = rig.chest;
    weapon.position.set(0.1, 0.34, 0.26);
    weapon.rotation.set(0, 0.06, 0);

    const body = MeshBuilder.CreateBox(
      `${id}-weapon-body`,
      { width: 0.066, height: 0.086, depth: 0.5 },
      this.scene,
    );
    body.parent = weapon;
    body.material = this.weaponMaterial;
    body.isPickable = false;
    rig.meshes.push(body);

    const barrel = MeshBuilder.CreateCylinder(
      `${id}-weapon-barrel`,
      { diameterTop: 0.026, diameterBottom: 0.032, height: 0.36, tessellation: seg },
      this.scene,
    );
    barrel.parent = weapon;
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.018, 0.4);
    barrel.material = this.weaponMaterial;
    barrel.isPickable = false;
    rig.meshes.push(barrel);

    const guard = MeshBuilder.CreateCylinder(
      `${id}-weapon-guard`,
      { diameter: 0.056, height: 0.22, tessellation: seg },
      this.scene,
    );
    guard.parent = weapon;
    guard.rotation.x = Math.PI / 2;
    guard.position.set(0, 0.012, 0.24);
    guard.material = this.accentMaterial;
    guard.isPickable = false;
    rig.meshes.push(guard);

    /*
     * A stock reaching back toward the shoulder, so the rifle is shouldered rather than floating at the chest. Contact at the
     * shoulder is what makes the grip read as held rather than held out.
     */
    const stock = MeshBuilder.CreateBox(
      `${id}-weapon-stock`,
      { width: 0.05, height: 0.11, depth: 0.2 },
      this.scene,
    );
    stock.parent = weapon;
    stock.position.set(0, -0.02, -0.26);
    stock.material = this.weaponMaterial;
    stock.isPickable = false;
    rig.meshes.push(stock);

    // A real trigger grip under the receiver gives the right palm a contact point.
    const triggerGrip = MeshBuilder.CreateBox(
      `${id}-weapon-trigger-grip`,
      { width: 0.052, height: 0.12, depth: 0.07 },
      this.scene,
    );
    triggerGrip.parent = weapon;
    triggerGrip.position.set(0, -0.075, -0.1);
    triggerGrip.material = this.accentMaterial;
    triggerGrip.isPickable = false;
    rig.meshes.push(triggerGrip);

    // The left palm wraps the rear part of the handguard, within the arm's natural reach.
    const supportGrip = new TransformNode(`${id}-weapon-support-grip`, this.scene);
    supportGrip.parent = weapon;
    supportGrip.position.copyFrom(guard.position);
    supportGrip.position.z -= 0.06;
    bindWeaponGrip(rig, weapon, triggerGrip.position, supportGrip.position);

    const muzzle = new TransformNode(`${id}-muzzle`, this.scene);
    muzzle.parent = weapon;
    muzzle.position.set(0, 0.018, 0.6);

    const flash = MeshBuilder.CreatePlane(`${id}-flash`, { size: 0.3 }, this.scene);
    flash.parent = muzzle;
    /*
     * Cloned per figure. A shared material whose alpha is animated would make every muzzle flash in the scene fade
     * together, which is the same defect the impact pool had.
     */
    flash.material = this.muzzleMaterial.clone(`${id}-muzzle-mat`);
    flash.billboardMode = 7;
    flash.isPickable = false;
    flash.setEnabled(false);

    this.meshGeneration += 1;

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
      oneShotUntil: 0,
      archetype: 0,
      aimPitch: 0,
      aiming: 0,
      hitToggle: false,
    };
  }

  private buildFromModel(model: LoadedCharacter): Figure {
    const id = `enemy-${this.built++}`;
    const root = new TransformNode(`enemy-root-${id}`, this.scene);
    const character = instantiateCharacter(model, this.scene, id, 1.8);
    character.root.parent = root;

    /*
     * The model brings its own weapon if the artist included one, and none of the catalogue models do. The muzzle marker
     * sits at a plausible offset from the body rather than on a hand bone: bone names vary per model and a wrong guess
     * puts the flash inside the chest.
     */
    const muzzle = new TransformNode(`${id}-muzzle`, this.scene);
    muzzle.parent = root;
    muzzle.position.set(0.22, 1.3, 0.5);

    const flash = MeshBuilder.CreatePlane(`${id}-flash`, { size: 0.3 }, this.scene);
    flash.parent = muzzle;
    flash.material = this.muzzleMaterial.clone(`${id}-muzzle-mat`);
    flash.billboardMode = 7;
    flash.isPickable = false;
    flash.setEnabled(false);

    this.meshGeneration += 1;

    return {
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
      oneShotUntil: 0,
      archetype: 0,
      aimPitch: 0,
      aiming: 0,
      hitToggle: false,
    };
  }

  private destroy(figure: Figure): void {
    figure.flash.material?.dispose();
    figure.flash.dispose();
    figure.muzzle.dispose();
    figure.character?.dispose();
    figure.rig?.root.dispose(false, true);
    figure.root.dispose(false, true);
    this.meshGeneration += 1;
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
    for (const entry of this.leaving.values()) collect(entry.figure);
    for (const corpse of this.corpses) collect(corpse.figure);
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
    figure.oneShotUntil = 0;
    figure.aimPitch = 0;
    figure.aiming = 0;
    figure.phase = 0;
    figure.hitToggle = false;

    if (figure.rig) {
      resetPose(figure.rig);
      poseWeaponGrip(figure.rig, false);
    }
    if (figure.character) {
      figure.character.current = null;
      // Weapon-ready idle for an armed enemy, falling back to a plain idle.
      playFirstAvailable(figure.character, ['aim', 'idle'], true);
    }
    this.applySkin(figure, 'normal');

    const build = ARCHETYPE_BUILD[archetype % ARCHETYPE_BUILD.length] ?? ARCHETYPE_BUILD[1]!;
    // Non-uniform scale: a heavy is wider as well as taller, which reads as mass.
    figure.root.scaling.set(build.width, build.scale, build.width);
    figure.root.rotation.set(0, 0, 0);
    figure.root.position.set(0, 0, 0);
    figure.root.setEnabled(true);
    for (const mesh of figure.meshes) mesh.visibility = 1;
    figure.flash.setEnabled(false);
    return figure;
  }

  private release(figure: Figure): void {
    figure.root.setEnabled(false);
    figure.flash.setEnabled(false);
    figure.phase = 0;
    figure.oneShotUntil = 0;
    this.pool.push(figure);
  }

  /**
   * Find a figure by id, including one that has just left the snapshot.
   *
   * Death and hit events arrive after the entity has gone from the snapshot, so the leaving set has to be searched or those
   * events land on nothing.
   */
  private find(id: number): Figure | null {
    return this.active.get(id) ?? this.leaving.get(id)?.figure ?? null;
  }

  /** Start a one-shot clip and record when it ends. */
  private playOneShot(
    figure: Figure,
    clips: readonly CharacterClip[],
    now: number,
    speed: number,
  ): void {
    const character = figure.character;
    if (!character) return;

    const clip = playFirstAvailable(character, clips, false, speed);
    if (!clip) return;

    /*
     * Duration from the clip itself where Babylon exposes it, so a long death animation is not cut short and a short flinch
     * does not block locomotion for longer than it plays. The fallback covers a clip with no frame range.
     */
    const group = character.clips.get(clip);
    const frames = group ? group.to - group.from : 0;
    const ms = frames > 0 ? (frames / 60) * 1000 / Math.max(0.1, speed) : DEFAULT_ONE_SHOT_MS;
    figure.oneShotUntil = now + ms;
  }

  /** Flash a body on hit, so damage is visible before the kill. */
  onHit(id: number, timestamp: number): void {
    const figure = this.find(id);
    if (!figure) return;
    figure.flinchUntil = timestamp + FLINCH_MS;
    this.applySkin(figure, 'flash');
    // A backward jolt at the spine reads as impact without disturbing the legs.
    if (figure.rig) figure.rig.spine.rotation.x = -0.16;

    if (figure.character) {
      /*
       * Alternate the two hit reactions. Repeated identical flinches under sustained fire read as a stuck animation, and
       * this model happens to ship two variants.
       */
      figure.hitToggle = !figure.hitToggle;
      const order: CharacterClip[] = figure.hitToggle ? ['hitAlt', 'hit'] : ['hit', 'hitAlt'];
      this.playOneShot(figure, order, timestamp, 1.4);
    }
  }

  /** An enemy fired: flash its muzzle so the player can see which one fired. */
  onShot(id: number, timestamp: number): void {
    const figure = this.find(id);
    if (!figure) return;
    figure.flashUntil = timestamp + MUZZLE_MS;
    if (figure.character) this.playOneShot(figure, ['shoot'], timestamp, 1.2);
  }

  /**
   * Start a death animation.
   *
   * Claims the figure from either the active or the leaving set. The simulation removes a dead entity on the same tick it
   * dies, and main updates this renderer from the snapshot before draining events, so by the time this runs the entity is
   * already gone from the snapshot. That is exactly what the leaving grace window is for.
   */
  onDeath(id: number, timestamp: number): void {
    const figure = this.find(id);
    if (!figure) return;
    this.active.delete(id);
    this.leaving.delete(id);

    this.applySkin(figure, 'damaged');
    figure.flash.setEnabled(false);
    // loop: false is essential. A looping death clip makes the corpse stand back up.
    if (figure.character) {
      playClip(figure.character, 'death', false);
      figure.oneShotUntil = timestamp + DEATH_MS;
    }
    this.corpses.push({ figure, until: timestamp + DEATH_MS, fallYaw: figure.root.rotation.y });
  }

  /** Position and animate every living enemy, then advance corpses. */
  update(frame: InterpolatedFrame, timestamp: number, dt: number): void {
    for (const [id, enemy] of frame.enemies) {
      // Reclaim a figure that was about to be released: the entity reappeared, so it never despawned.
      const leaving = this.leaving.get(id);
      if (leaving) {
        this.leaving.delete(id);
        this.active.set(id, leaving.figure);
      }

      let figure = this.active.get(id);
      if (!figure) {
        figure = this.acquire(enemy.archetype);
        figure.lastX = enemy.x;
        figure.lastZ = enemy.z;
        this.active.set(id, figure);
      }
      this.place(figure, enemy, timestamp, dt);
    }

    /*
     * An entity missing from the snapshot is NOT released immediately. main calls this method before draining visual
     * events, so a death event for this entity is still in the queue; releasing now would return the figure to the pool and
     * onDeath would find nothing, which is why no death animation ever played.
     */
    for (const [id, figure] of this.active) {
      if (!frame.enemies.has(id)) {
        this.active.delete(id);
        this.leaving.set(id, { figure, since: timestamp });
      }
    }

    /*
     * Release anything still in the grace window after one frame. A despawn (wave reset, round end) has no death event, so
     * without this the figures would leak. 100 ms is generous: the death event arrives in the same frame.
     */
    for (const [id, entry] of this.leaving) {
      if (timestamp - entry.since > 100) {
        this.release(entry.figure);
        this.leaving.delete(id);
      }
    }

    this.updateCorpses(timestamp);
  }

  private place(
    figure: Figure,
    enemy: InterpolatedEnemy,
    timestamp: number,
    dt: number,
  ): void {
    figure.root.position.set(enemy.x, enemy.y, enemy.z);
    const yawRad = enemy.yaw * Math.PI * 2;
    figure.root.rotation.y = yawRad;

    // Recover from a hit flinch, then tint by remaining health.
    if (figure.flinchUntil > 0 && timestamp >= figure.flinchUntil) {
      figure.flinchUntil = 0;
      if (figure.rig) figure.rig.spine.rotation.x = 0;
    }
    if (figure.flinchUntil === 0) {
      this.applySkin(figure, enemy.healthFraction < 0.45 ? 'damaged' : 'normal');
    }

    const firing = timestamp < figure.flashUntil;
    figure.flash.setEnabled(firing);

    // Distance travelled this frame, and its direction in world space.
    const dx = enemy.x - figure.lastX;
    const dz = enemy.z - figure.lastZ;
    const travelled = Math.sqrt(dx * dx + dz * dz);
    figure.lastX = enemy.x;
    figure.lastZ = enemy.z;
    const speed = dt > 0 ? travelled / dt : 0;

    if (figure.character) {
      this.animateModel(figure, enemy, speed, dx, dz, yawRad, firing, timestamp);
    } else if (figure.rig) {
      this.animateProcedural(figure, enemy, travelled, dt);
    }
  }

  /**
   * Drive a glTF figure from its clips.
   *
   * Direction is resolved into the figure's own frame, so a clip is chosen by where it is going relative to where it is
   * looking. An enemy backing away from the player while facing them should play a backpedal, not a forward run; playing
   * forward makes the feet slide and is the single most visible animation error available.
   */
  private animateModel(
    figure: Figure,
    enemy: InterpolatedEnemy,
    speed: number,
    dx: number,
    dz: number,
    yawRad: number,
    firing: boolean,
    timestamp: number,
  ): void {
    const character = figure.character!;

    /*
     * A one-shot is left to finish, decided by TIME rather than by the clip name. The name check that used to live here
     * never became false, so a figure that flinched once was frozen for the rest of its life.
     */
    if (figure.oneShotUntil > 0) {
      if (timestamp < figure.oneShotUntil) return;
      figure.oneShotUntil = 0;
      // Fall through and pick a locomotion clip this same frame, so there is no idle gap after a flinch.
    }

    if (speed <= IDLE_THRESHOLD) {
      // Standing. Telegraphing gets the pointing pose, engaging gets weapon-ready, else plain idle.
      if (enemy.telegraphing) {
        playFirstAvailable(character, ['aimPointing', 'aim', 'idle'], true);
      } else if (enemy.brain === 2) {
        playFirstAvailable(character, ['aim', 'idle'], true);
      } else {
        playFirstAvailable(character, ['idleNeutral', 'idle'], true);
      }
      setClipSpeed(character, 1);
      return;
    }

    // Firing while moving, where the model has a clip for it.
    if (firing && playFirstAvailable(character, ['shootMoving'], true, 1)) return;

    /*
     * Rotate the world-space movement vector into the figure's local frame. Forward is +Z at yaw 0, matching the
     * simulation's convention and the camera's.
     */
    const sin = Math.sin(yawRad);
    const cos = Math.cos(yawRad);
    const localForward = dx * sin + dz * cos;
    const localRight = dx * cos - dz * sin;

    const running = speed > RUN_THRESHOLD;
    // Sideways only when it dominates: a slight lateral drift while advancing is still forward.
    const sideways = Math.abs(localRight) > Math.abs(localForward) * 1.3;

    let played: CharacterClip | null;
    if (sideways) {
      played =
        localRight > 0
          ? playFirstAvailable(character, ['runRight', 'run', 'walk'], true)
          : playFirstAvailable(character, ['runLeft', 'run', 'walk'], true);
    } else if (localForward < 0) {
      // Backpedalling. Without a dedicated clip a reversed forward run looks wrong, so walk is the better fallback.
      played = playFirstAvailable(character, ['runBack', 'walk', 'run'], true);
    } else if (running) {
      played = playFirstAvailable(character, ['run', 'walk'], true);
    } else {
      played = playFirstAvailable(character, ['walk', 'run'], true);
    }

    
if (played) {
      // Scale playback to measured speed against the clip's authored speed, so feet do not slide.
      const authored = played === 'run' ? RUN_CLIP_SPEED : WALK_CLIP_SPEED;
      setClipSpeed(character, Math.max(0.4, Math.min(2.4, speed / authored)));
    }
  }

  /** Legs animate the stride; the arm pose keeps both palms on the chest-mounted rifle. */
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
     * Knees only bend on the backswing. A knee that bends in both directions looks like a puppet; bending only when the leg
     * travels backwards is what a real stride does, and it is the detail that makes the walk legible at a distance.
     */
    rig.kneeLeft.rotation.x = Math.max(0, -swing) * amplitude * 1.5;
    rig.kneeRight.rotation.x = Math.max(0, swing) * amplitude * 1.5;

    // A slight vertical bob and a counter-rotation at the pelvis complete the stride.
    rig.pelvis.position.y = RIG.pelvisY - Math.abs(Math.cos(figure.phase)) * amplitude * 0.045;
    rig.pelvis.rotation.y = swing * amplitude * 0.12;
    // The chest counter-rotates against the hips, which is what stops the torso looking rigid.
    rig.chest.rotation.y = -swing * amplitude * 0.16;

    // Aim changes the elbow bend plane; both poses keep the same palm contact points.
    const wantAim = enemy.brain === 2 || enemy.telegraphing ? 1 : 0;
    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);
    figure.aiming = ease(figure.aiming, wantAim, 8);
    poseWeaponGrip(rig, figure.aiming > 0.5);

    /*
     * A telegraph raises the weapon and drops the head into an aiming line. This is the procedural equivalent of the
     * aimPointing clip, and it is the only warning a player gets before a heavy fires.
     */
    const telegraph = enemy.telegraphing ? 1 : 0;
    figure.aimPitch = ease(figure.aimPitch, telegraph * -0.12, 10);
    rig.neck.rotation.x = figure.aimPitch;
    rig.spine.rotation.x = figure.flinchUntil > 0 ? -0.16 : figure.aimPitch * 0.5;
  }

  
/**
   * Advance corpses.
   *
   * A glTF figure plays its own death clip, so only the fade is applied. A procedural one is folded by hand.
   */
  private updateCorpses(timestamp: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i]!;
      const remaining = (corpse.until - timestamp) / DEATH_MS;
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

      // Fade over the last 35% so the corpse does not pop out. Per-mesh visibility, never material alpha.
      const fade = remaining < 0.35 ? remaining / 0.35 : 1;
      for (const mesh of figure.meshes) mesh.visibility = fade;
    }
  }

  /** World position of an enemy's chest, for impact effects. */
  chestPosition(id: number): Vector3 | null {
    const figure = this.find(id);
    if (!figure) return null;
    if (figure.rig) return figure.rig.chest.getAbsolutePosition();
    return figure.root.getAbsolutePosition().add(new Vector3(0, 1.1, 0));
  }

  dispose(): void {
    for (const figure of this.active.values()) this.destroy(figure);
    for (const entry of this.leaving.values()) this.destroy(entry.figure);
    for (const corpse of this.corpses) this.destroy(corpse.figure);
    for (const figure of this.pool) this.destroy(figure);
    this.active.clear();
    this.leaving.clear();
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
