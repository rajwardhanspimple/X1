/**
 * Enemy rendering.
 *
 * Three decisions worth noting:
 *
 * Figures are pooled by entity id, because creating and disposing meshes mid-round is the most
 * reliable way to produce a frame spike in Babylon and a wave spawns eight at once.
 *
 * The walk cycle is driven by distance travelled, not a timer. A timer-driven cycle keeps marching
 * when the figure stops, which reads as broken; advancing by actual movement means the legs match
 * the speed and stop dead on stopping.
 *
 * Death detaches the figure from the live set and animates it separately. The simulation removes a
 * dead entity immediately, which is correct for gameplay, but a body that blinks out of existence
 * reads as a bug. Detaching lets the corpse finish its collapse while the sim moves on.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { InterpolatedFrame, InterpolatedPose } from './interpolator.js';

const TOTAL_HEIGHT = 1.8;
const LEG_LENGTH = 0.8;
const TORSO_HEIGHT = 0.62;
const HEAD_SIZE = 0.3;

const ARCHETYPE_COLOURS = ['#e0644f', '#e0a94f', '#b44fe0'];
const ARCHETYPE_SCALE = [1, 1, 1.18];

const FLINCH_MS = 110;
const DEATH_MS = 900;

interface Figure {
  root: TransformNode;
  hips: TransformNode;
  legLeft: TransformNode;
  legRight: TransformNode;
  armLeft: TransformNode;
  armRight: TransformNode;
  torso: Mesh;
  head: Mesh;
  bodyMeshes: Mesh[];
  meshes: Mesh[];
  /** Walk cycle phase, advanced by distance travelled. */
  phase: number;
  lastX: number;
  lastZ: number;
  flinchUntil: number;
  archetype: number;
}

interface Corpse {
  figure: Figure;
  until: number;
  /** Direction the body topples, derived from its facing at death. */
  fallYaw: number;
}

export class EnemyRenderer {
  private readonly pool: Figure[] = [];
  private readonly active = new Map<number, Figure>();
  private readonly corpses: Corpse[] = [];
  private readonly materials: StandardMaterial[] = [];
  private readonly flashMaterial: StandardMaterial;
  private readonly darkMaterial: StandardMaterial;
  private readonly weaponMaterial: StandardMaterial;

  constructor(private readonly scene: Scene) {
    for (let i = 0; i < ARCHETYPE_COLOURS.length; i++) {
      const m = new StandardMaterial(`enemy-${i}`, scene);
      const colour = Color3.FromHexString(ARCHETYPE_COLOURS[i]!);
      m.diffuseColor = colour;
      m.emissiveColor = colour.scale(0.18);
      m.specularColor = new Color3(0.12, 0.12, 0.14);
      this.materials.push(m);
    }

    // A hit flashes the body to near-white, which reads instantly at any distance or colour.
    this.flashMaterial = new StandardMaterial('enemy-flash', scene);
    this.flashMaterial.diffuseColor = Color3.White();
    this.flashMaterial.emissiveColor = new Color3(0.85, 0.85, 0.85);

    this.darkMaterial = new StandardMaterial('enemy-dark', scene);
    this.darkMaterial.diffuseColor = Color3.FromHexString('#20242e');
    this.darkMaterial.specularColor = new Color3(0.06, 0.06, 0.08);

    this.weaponMaterial = new StandardMaterial('enemy-weapon', scene);
    this.weaponMaterial.diffuseColor = Color3.FromHexString('#3a414f');
    this.weaponMaterial.specularColor = new Color3(0.2, 0.2, 0.22);
  }

  /**
   * Build one figure. Parts hang off pivots so rotating a pivot swings the limb from its joint
   * rather than around its own centre.
   */
  private build(index: number): Figure {
    const scene = this.scene;
    const id = `${index}-${this.pool.length}-${this.active.size}`;
    const meshes: Mesh[] = [];
    const bodyMeshes: Mesh[] = [];

    const root = new TransformNode(`enemy-root-${id}`, scene);

    const hips = new TransformNode(`enemy-hips-${id}`, scene);
    hips.parent = root;
    hips.position.y = LEG_LENGTH;

    const torso = MeshBuilder.CreateBox(
      `enemy-torso-${id}`,
      { width: 0.52, height: TORSO_HEIGHT, depth: 0.3 },
      scene,
    );
    torso.parent = hips;
    torso.position.y = TORSO_HEIGHT / 2;
    meshes.push(torso);
    bodyMeshes.push(torso);

    const head = MeshBuilder.CreateBox(
      `enemy-head-${id}`,
      { width: HEAD_SIZE, height: HEAD_SIZE, depth: HEAD_SIZE },
      scene,
    );
    head.parent = hips;
    head.position.y = TORSO_HEIGHT + HEAD_SIZE / 2 + 0.06;
    meshes.push(head);
    bodyMeshes.push(head);

    const armLeft = new TransformNode(`enemy-arm-l-${id}`, scene);
    armLeft.parent = hips;
    armLeft.position.set(-0.33, TORSO_HEIGHT - 0.1, 0);
    const armLeftMesh = MeshBuilder.CreateBox(
      `enemy-arm-l-mesh-${id}`,
      { width: 0.14, height: 0.56, depth: 0.14 },
      scene,
    );
    armLeftMesh.parent = armLeft;
    armLeftMesh.position.y = -0.28;
    meshes.push(armLeftMesh);
    bodyMeshes.push(armLeftMesh);

    const armRight = new TransformNode(`enemy-arm-r-${id}`, scene);
    armRight.parent = hips;
    armRight.position.set(0.33, TORSO_HEIGHT - 0.1, 0);
    const armRightMesh = MeshBuilder.CreateBox(
      `enemy-arm-r-mesh-${id}`,
      { width: 0.14, height: 0.56, depth: 0.14 },
      scene,
    );
    armRightMesh.parent = armRight;
    armRightMesh.position.y = -0.28;
    meshes.push(armRightMesh);
    bodyMeshes.push(armRightMesh);

    const weapon = MeshBuilder.CreateBox(
      `enemy-weapon-${id}`,
      { width: 0.08, height: 0.1, depth: 0.62 },
      scene,
    );
    weapon.parent = hips;
    weapon.position.set(0.16, TORSO_HEIGHT - 0.22, 0.26);
    weapon.material = this.weaponMaterial;
    meshes.push(weapon);

    const legLeft = new TransformNode(`enemy-leg-l-${id}`, scene);
    legLeft.parent = root;
    legLeft.position.set(-0.14, LEG_LENGTH, 0);
    const legLeftMesh = MeshBuilder.CreateBox(
      `enemy-leg-l-mesh-${id}`,
      { width: 0.18, height: LEG_LENGTH, depth: 0.18 },
      scene,
    );
    legLeftMesh.parent = legLeft;
    legLeftMesh.position.y = -LEG_LENGTH / 2;
    legLeftMesh.material = this.darkMaterial;
    meshes.push(legLeftMesh);

    const legRight = new TransformNode(`enemy-leg-r-${id}`, scene);
    legRight.parent = root;
    legRight.position.set(0.14, LEG_LENGTH, 0);
    const legRightMesh = MeshBuilder.CreateBox(
      `enemy-leg-r-mesh-${id}`,
      { width: 0.18, height: LEG_LENGTH, depth: 0.18 },
      scene,
    );
    legRightMesh.parent = legRight;
    legRightMesh.position.y = -LEG_LENGTH / 2;
    legRightMesh.material = this.darkMaterial;
    meshes.push(legRightMesh);

    for (const mesh of meshes) {
      mesh.isPickable = false;
      mesh.receiveShadows = true;
    }

    return {
      root,
      hips,
      legLeft,
      legRight,
      armLeft,
      armRight,
      torso,
      head,
      bodyMeshes,
      meshes,
      phase: 0,
      lastX: 0,
      lastZ: 0,
      flinchUntil: 0,
      archetype: 0,
    };
  }

  /** Meshes that should cast shadows, for the shadow generator to register. */
  shadowCasters(): Mesh[] {
    const all: Mesh[] = [];
    for (const figure of this.active.values()) all.push(...figure.meshes);
    for (const figure of this.pool) all.push(...figure.meshes);
    return all;
  }

  private applyMaterials(figure: Figure, flashing: boolean): void {
    const material = flashing
      ? this.flashMaterial
      : (this.materials[figure.archetype % this.materials.length] ?? null);
    for (const mesh of figure.bodyMeshes) mesh.material = material;
  }

  private acquire(archetype: number): Figure {
    const figure = this.pool.pop() ?? this.build(this.active.size);
    figure.archetype = archetype;
    figure.flinchUntil = 0;
    this.applyMaterials(figure, false);
    const scale = ARCHETYPE_SCALE[archetype % ARCHETYPE_SCALE.length] ?? 1;
    figure.root.scaling.setAll(scale);
    figure.root.rotation.set(0, 0, 0);
    figure.hips.rotation.set(0, 0, 0);
    figure.root.setEnabled(true);
    for (const mesh of figure.meshes) mesh.visibility = 1;
    return figure;
  }

  private release(figure: Figure): void {
    figure.root.setEnabled(false);
    figure.phase = 0;
    this.pool.push(figure);
  }

  /** Flash a body on hit, so damage is visible before the kill. */
  onHit(id: number, now: number): void {
    const figure = this.active.get(id);
    if (!figure) return;
    figure.flinchUntil = now + FLINCH_MS;
    this.applyMaterials(figure, true);
    // A small backward jolt on the torso reads as impact without disturbing the walk.
    figure.hips.rotation.x = -0.14;
  }

  /**
   * Start a death animation. The figure leaves the live set, so the simulation is free to remove
   * the entity on the same tick while the body finishes collapsing.
   */
  onDeath(id: number, now: number): void {
    const figure = this.active.get(id);
    if (!figure) return;
    this.active.delete(id);
    this.applyMaterials(figure, false);
    this.corpses.push({ figure, until: now + DEATH_MS, fallYaw: figure.root.rotation.y });
  }

  /** Position and animate every living enemy, then advance any corpses. */
  update(frame: InterpolatedFrame, now: number): void {
    for (const [id, pose] of frame.enemies) {
      let figure = this.active.get(id);
      if (!figure) {
        // Archetype is not carried in the pose, so derive a stable index from the id until the
        // snapshot includes it. Stable per enemy, which is all the visuals need.
        figure = this.acquire(id % ARCHETYPE_COLOURS.length);
        figure.lastX = pose.x;
        figure.lastZ = pose.z;
        this.active.set(id, figure);
      }
      this.place(figure, pose, now);
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

  private place(figure: Figure, pose: InterpolatedPose, now: number): void {
    figure.root.position.set(pose.x, pose.y, pose.z);
    figure.root.rotation.y = pose.yaw * Math.PI * 2;

    if (figure.flinchUntil > 0 && now >= figure.flinchUntil) {
      figure.flinchUntil = 0;
      this.applyMaterials(figure, false);
      figure.hips.rotation.x = 0;
    }

    // Advance the walk cycle by the distance covered since the last frame.
    const dx = pose.x - figure.lastX;
    const dz = pose.z - figure.lastZ;
    const travelled = Math.sqrt(dx * dx + dz * dz);
    figure.lastX = pose.x;
    figure.lastZ = pose.z;
    figure.phase += travelled * 3.4;

    const swing = Math.sin(figure.phase);
    const amplitude = Math.min(0.75, travelled * 26);

    figure.legLeft.rotation.x = swing * amplitude;
    figure.legRight.rotation.x = -swing * amplitude;
    figure.armLeft.rotation.x = -swing * amplitude * 0.45 - 0.55;
    figure.armRight.rotation.x = swing * amplitude * 0.3 - 0.75;
    figure.hips.position.y = LEG_LENGTH + Math.abs(Math.cos(figure.phase)) * amplitude * 0.06;
  }

  /** Topple, sink and fade. Cheap, and far better than blinking out. */
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
      const figure = corpse.figure;
      // Fall forward over the first third, then hold.
      const fall = Math.min(1, progress * 3);
      figure.root.rotation.x = fall * (Math.PI / 2) * 0.92;
      figure.root.rotation.y = corpse.fallYaw;
      // Sink slightly so the body settles rather than floating at standing height.
      figure.root.position.y = Math.max(-0.35, -fall * 0.3);
      // Limbs go slack.
      figure.legLeft.rotation.x = fall * 0.4;
      figure.legRight.rotation.x = fall * 0.25;
      figure.armLeft.rotation.x = -0.55 + fall * 1.1;
      figure.armRight.rotation.x = -0.75 + fall * 1.3;
      // Fade out over the last 40% so the corpse does not pop.
      const fade = remaining < 0.4 ? remaining / 0.4 : 1;
      for (const mesh of figure.meshes) mesh.visibility = fade;
    }
  }

  /** World position of an enemy's chest, for impact effects. */
  chestPosition(id: number): Vector3 | null {
    const figure = this.active.get(id);
    if (!figure) return null;
    return figure.hips.getAbsolutePosition().add(new Vector3(0, TORSO_HEIGHT / 2, 0));
  }

  dispose(): void {
    for (const figure of this.active.values()) figure.root.dispose(false, true);
    for (const corpse of this.corpses) corpse.figure.root.dispose(false, true);
    for (const figure of this.pool) figure.root.dispose(false, true);
    this.active.clear();
    this.corpses.length = 0;
    this.pool.length = 0;
    for (const m of this.materials) m.dispose();
    this.flashMaterial.dispose();
    this.darkMaterial.dispose();
    this.weaponMaterial.dispose();
  }
}

export const ENEMY_TOTAL_HEIGHT = TOTAL_HEIGHT;
