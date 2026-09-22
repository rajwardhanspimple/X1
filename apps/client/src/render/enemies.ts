/**
 * Enemy rendering.
 *
 * Figures are assembled from primitives and pooled by entity id. Two decisions matter:
 *
 * Pooling, because creating and disposing meshes mid-round is the most reliable way to produce a
 * frame spike in Babylon, and a wave spawning eight enemies at once would show it.
 *
 * The walk cycle is driven by distance travelled, not by a timer. A timer-driven cycle keeps
 * marching when the figure stops, which reads as broken; advancing the phase by how far the figure
 * actually moved means the legs match the speed and stop when it stops.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { InterpolatedFrame, InterpolatedPose } from './interpolator.js';

/** Matches the simulation's enemy hitbox: 1.8 units tall, head above 1.48. */
const TOTAL_HEIGHT = 1.8;
const LEG_LENGTH = 0.8;
const TORSO_HEIGHT = 0.62;
const HEAD_SIZE = 0.3;

const ARCHETYPE_COLOURS = ['#e0644f', '#e0a94f', '#b44fe0'];
const ARCHETYPE_SCALE = [1, 1, 1.18];

interface Figure {
  root: TransformNode;
  hips: TransformNode;
  legLeft: TransformNode;
  legRight: TransformNode;
  armLeft: TransformNode;
  armRight: TransformNode;
  head: Mesh;
  meshes: Mesh[];
  /** Walk cycle phase, advanced by distance travelled. */
  phase: number;
  lastX: number;
  lastZ: number;
}

export class EnemyRenderer {
  private readonly pool: Figure[] = [];
  private readonly active = new Map<number, Figure>();
  private readonly materials: StandardMaterial[] = [];
  private readonly darkMaterial: StandardMaterial;
  private readonly weaponMaterial: StandardMaterial;

  constructor(private readonly scene: Scene) {
    for (let i = 0; i < ARCHETYPE_COLOURS.length; i++) {
      const m = new StandardMaterial(`enemy-${i}`, scene);
      const colour = Color3.FromHexString(ARCHETYPE_COLOURS[i]!);
      m.diffuseColor = colour;
      m.emissiveColor = colour.scale(0.22);
      m.specularColor = new Color3(0.1, 0.1, 0.12);
      this.materials.push(m);
    }

    this.darkMaterial = new StandardMaterial('enemy-dark', scene);
    this.darkMaterial.diffuseColor = Color3.FromHexString('#20242e');
    this.darkMaterial.specularColor = new Color3(0.06, 0.06, 0.08);

    this.weaponMaterial = new StandardMaterial('enemy-weapon', scene);
    this.weaponMaterial.diffuseColor = Color3.FromHexString('#3a414f');
    this.weaponMaterial.specularColor = new Color3(0.2, 0.2, 0.22);
  }

  /**
   * Build one figure. Parts are parented to pivots so a rotation on a pivot swings the limb from
   * its joint rather than around its own centre.
   */
  private build(index: number): Figure {
    const scene = this.scene;
    const id = `${index}-${this.pool.length}`;
    const meshes: Mesh[] = [];

    const root = new TransformNode(`enemy-root-${id}`, scene);

    // Hips: everything above the legs hangs off this, so a crouch or a hit reaction moves it all.
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

    const head = MeshBuilder.CreateBox(
      `enemy-head-${id}`,
      { width: HEAD_SIZE, height: HEAD_SIZE, depth: HEAD_SIZE },
      scene,
    );
    head.parent = hips;
    head.position.y = TORSO_HEIGHT + HEAD_SIZE / 2 + 0.06;
    meshes.push(head);

    // Shoulder pivots at the top of the torso.
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

    // A rifle held across the chest, so the silhouette reads as armed.
    const weapon = MeshBuilder.CreateBox(
      `enemy-weapon-${id}`,
      { width: 0.08, height: 0.1, depth: 0.62 },
      scene,
    );
    weapon.parent = hips;
    weapon.position.set(0.16, TORSO_HEIGHT - 0.22, 0.26);
    weapon.material = this.weaponMaterial;
    meshes.push(weapon);

    // Hip pivots for the legs.
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

    for (const mesh of meshes) mesh.isPickable = false;

    return {
      root,
      hips,
      legLeft,
      legRight,
      armLeft,
      armRight,
      head,
      meshes,
      phase: 0,
      lastX: 0,
      lastZ: 0,
    };
  }

  private acquire(archetype: number): Figure {
    const figure = this.pool.pop() ?? this.build(this.active.size);
    const bodyMaterial = this.materials[archetype % this.materials.length] ?? null;
    // Torso and head take the archetype colour; limbs stay dark for contrast.
    figure.meshes[0]!.material = bodyMaterial;
    figure.head.material = bodyMaterial;
    figure.meshes[2]!.material = bodyMaterial;
    figure.meshes[3]!.material = bodyMaterial;
    const scale = ARCHETYPE_SCALE[archetype % ARCHETYPE_SCALE.length] ?? 1;
    figure.root.scaling.setAll(scale);
    figure.root.setEnabled(true);
    return figure;
  }

  private release(figure: Figure): void {
    figure.root.setEnabled(false);
    figure.phase = 0;
    this.pool.push(figure);
  }

  /** Position and animate every enemy from the interpolated frame. */
  update(frame: InterpolatedFrame): void {
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
      this.place(figure, pose);
    }

    for (const [id, figure] of this.active) {
      if (!frame.enemies.has(id)) {
        this.release(figure);
        this.active.delete(id);
      }
    }
  }

  private place(figure: Figure, pose: InterpolatedPose): void {
    figure.root.position.set(pose.x, pose.y, pose.z);
    figure.root.rotation.y = pose.yaw * Math.PI * 2;

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
    // Arms counter-swing, damped, and keep a slight forward hold for the weapon.
    figure.armLeft.rotation.x = -swing * amplitude * 0.45 - 0.55;
    figure.armRight.rotation.x = swing * amplitude * 0.3 - 0.75;
    // A small vertical bob sells the stride without needing a knee joint.
    figure.hips.position.y = LEG_LENGTH + Math.abs(Math.cos(figure.phase)) * amplitude * 0.06;
  }

  /** World position of an enemy's chest, for impact effects. */
  chestPosition(id: number): Vector3 | null {
    const figure = this.active.get(id);
    if (!figure) return null;
    return figure.hips.getAbsolutePosition().add(new Vector3(0, TORSO_HEIGHT / 2, 0));
  }

  dispose(): void {
    for (const figure of this.active.values()) figure.root.dispose(false, true);
    for (const figure of this.pool) figure.root.dispose(false, true);
    this.active.clear();
    this.pool.length = 0;
    for (const m of this.materials) m.dispose();
    this.darkMaterial.dispose();
    this.weaponMaterial.dispose();
  }
}

export const ENEMY_TOTAL_HEIGHT = TOTAL_HEIGHT;
