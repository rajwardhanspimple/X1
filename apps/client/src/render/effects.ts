/**
 * Tracers and impact effects.
 *
 * Both are fixed-size pools allocated once. Creating and disposing meshes during sustained fire is
 * the most reliable way to produce frame spikes in Babylon, and an automatic weapon at 500 rounds
 * per minute would do exactly that. When a pool is exhausted the oldest entry is recycled, which is
 * invisible in practice and always cheaper than allocating.
 *
 * The shot ray comes from the simulation's event, not from a client-side recomputation, so a tracer
 * shows the exact line the bullet travelled, including spread and recoil.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';

const TRACER_POOL = 48;
const TRACER_LIFE_MS = 70;
const IMPACT_POOL = 32;
const IMPACT_LIFE_MS = 180;

interface PooledEntry<T> {
  mesh: T;
  until: number;
}

export interface TracerRequest {
  from: Vector3;
  to: Vector3;
}

export interface ImpactRequest {
  at: Vector3;
  /** Body hits get a warmer, larger flash than geometry, so a hit is legible without the marker. */
  onBody: boolean;
}

export class TracerPool {
  private readonly entries: PooledEntry<Mesh>[] = [];
  private cursor = 0;

  constructor(scene: Scene) {
    const mat = new StandardMaterial('tracer', scene);
    mat.emissiveColor = Color3.FromHexString('#ffe9a8');
    mat.diffuseColor = Color3.Black();
    mat.disableLighting = true;
    mat.alpha = 0.85;

    for (let i = 0; i < TRACER_POOL; i++) {
      // A unit-length box along Z, scaled per shot. Cheaper than rebuilding a line mesh.
      const mesh = MeshBuilder.CreateBox(
        `tracer-${i}`,
        { width: 0.03, height: 0.03, depth: 1 },
        scene,
      );
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.entries.push({ mesh, until: 0 });
    }
  }

  spawn(request: TracerRequest, now: number): void {
    const entry = this.entries[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.entries.length;

    const from = request.from;
    const to = request.to;
    const direction = to.subtract(from);
    const length = direction.length();
    if (length < 0.01) return;

    const mesh = entry.mesh;
    // Position at the midpoint and stretch along Z, then rotate Z onto the ray.
    mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    mesh.scaling.set(1, 1, length);
    mesh.lookAt(to);
    mesh.setEnabled(true);
    entry.until = now + TRACER_LIFE_MS;
  }

  update(now: number): void {
    for (const entry of this.entries) {
      if (entry.until === 0) continue;
      if (now >= entry.until) {
        entry.mesh.setEnabled(false);
        entry.until = 0;
        continue;
      }
      // Thin out over its life so it reads as a streak rather than a solid rod.
      const remaining = (entry.until - now) / TRACER_LIFE_MS;
      entry.mesh.scaling.x = remaining;
      entry.mesh.scaling.y = remaining;
    }
  }

  dispose(): void {
    for (const entry of this.entries) entry.mesh.dispose();
    this.entries.length = 0;
  }
}

export class ImpactPool {
  private readonly entries: PooledEntry<Mesh>[] = [];
  private cursor = 0;
  private readonly bodyMaterial: StandardMaterial;
  private readonly worldMaterial: StandardMaterial;

  constructor(scene: Scene) {
    this.bodyMaterial = new StandardMaterial('impact-body', scene);
    this.bodyMaterial.emissiveColor = Color3.FromHexString('#ff6a6a');
    this.bodyMaterial.diffuseColor = Color3.Black();
    this.bodyMaterial.disableLighting = true;

    this.worldMaterial = new StandardMaterial('impact-world', scene);
    this.worldMaterial.emissiveColor = Color3.FromHexString('#cfd6e4');
    this.worldMaterial.diffuseColor = Color3.Black();
    this.worldMaterial.disableLighting = true;

    for (let i = 0; i < IMPACT_POOL; i++) {
      const mesh = MeshBuilder.CreatePlane(`impact-${i}`, { size: 0.28 }, scene);
      // Billboard so a flat quad reads as a burst from any viewing angle.
      mesh.billboardMode = 7;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.entries.push({ mesh, until: 0 });
    }
  }

  spawn(request: ImpactRequest, now: number): void {
    const entry = this.entries[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.entries.length;
    const mesh = entry.mesh;
    mesh.position.copyFrom(request.at);
    mesh.material = request.onBody ? this.bodyMaterial : this.worldMaterial;
    mesh.scaling.setAll(request.onBody ? 1.4 : 1);
    mesh.setEnabled(true);
    entry.until = now + IMPACT_LIFE_MS;
  }

  update(now: number): void {
    for (const entry of this.entries) {
      if (entry.until === 0) continue;
      if (now >= entry.until) {
        entry.mesh.setEnabled(false);
        entry.until = 0;
        continue;
      }
      const remaining = (entry.until - now) / IMPACT_LIFE_MS;
      entry.mesh.scaling.setAll(0.4 + remaining * 1.1);
      if (entry.mesh.material) entry.mesh.material.alpha = remaining;
    }
  }

  dispose(): void {
    for (const entry of this.entries) entry.mesh.dispose();
    this.entries.length = 0;
    this.bodyMaterial.dispose();
    this.worldMaterial.dispose();
  }
}
