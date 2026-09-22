/**
 * Enemy rendering.
 *
 * Meshes are pooled and keyed by entity id. Creating and disposing meshes mid-round is the most
 * common cause of frame spikes in Babylon, and a wave spawning eight enemies at once would be
 * visible as a stutter. The pool grows to its high-water mark and then reuses.
 *
 * Nothing here reads gameplay state directly: positions come from the interpolated snapshot, so
 * enemies move as smoothly as the player does regardless of frame rate.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { InterpolatedFrame } from './interpolator.js';

const ENEMY_HEIGHT = 1.8;
const ENEMY_WIDTH = 0.8;

/** One material per archetype so an enemy type is readable at a glance. */
const ARCHETYPE_COLOURS = ['#e0644f', '#e0a94f', '#b44fe0'];

export class EnemyRenderer {
  private readonly pool: Mesh[] = [];
  private readonly active = new Map<number, Mesh>();
  private readonly materials: StandardMaterial[] = [];

  constructor(private readonly scene: Scene) {
    for (let i = 0; i < ARCHETYPE_COLOURS.length; i++) {
      const m = new StandardMaterial(`enemy-${i}`, scene);
      const colour = Color3.FromHexString(ARCHETYPE_COLOURS[i]!);
      m.diffuseColor = colour;
      m.emissiveColor = colour.scale(0.25);
      m.specularColor = new Color3(0.1, 0.1, 0.1);
      this.materials.push(m);
    }
  }

  private acquire(): Mesh {
    const reused = this.pool.pop();
    if (reused) {
      reused.setEnabled(true);
      return reused;
    }
    const mesh = MeshBuilder.CreateBox(
      `enemy-body-${this.active.size}-${this.pool.length}`,
      { width: ENEMY_WIDTH, height: ENEMY_HEIGHT, depth: ENEMY_WIDTH },
      this.scene,
    );
    // A small marker box on top reads as a head, which makes headshots legible.
    const head = MeshBuilder.CreateBox(
      `${mesh.name}-head`,
      { width: 0.42, height: 0.36, depth: 0.42 },
      this.scene,
    );
    head.parent = mesh;
    head.position.y = ENEMY_HEIGHT / 2 - 0.1;
    return mesh;
  }

  private release(mesh: Mesh): void {
    mesh.setEnabled(false);
    this.pool.push(mesh);
  }

  /** Position every enemy from the interpolated frame; hide meshes for entities that are gone. */
  update(frame: InterpolatedFrame): void {
    for (const [id, pose] of frame.enemies) {
      let mesh = this.active.get(id);
      if (!mesh) {
        mesh = this.acquire();
        // Archetype is not in the snapshot pose, so colour by id parity as a stand-in until the
        // snapshot carries it. Stable per enemy, which is what matters visually.
        mesh.material = this.materials[id % this.materials.length] ?? null;
        this.active.set(id, mesh);
      }
      // Snapshot y is the foot; the box is centred, so lift by half its height.
      mesh.position.set(pose.x, pose.y + ENEMY_HEIGHT / 2, pose.z);
      mesh.rotation.y = pose.yaw * Math.PI * 2;
    }

    // Anything no longer in the frame has died or despawned.
    for (const [id, mesh] of this.active) {
      if (!frame.enemies.has(id)) {
        this.release(mesh);
        this.active.delete(id);
      }
    }
  }

  dispose(): void {
    for (const mesh of this.active.values()) mesh.dispose();
    for (const mesh of this.pool) mesh.dispose();
    this.active.clear();
    this.pool.length = 0;
  }
}
