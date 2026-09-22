/**
 * Tracers, impacts and shell casings.
 *
 * All three are fixed-size pools allocated once. Creating and disposing meshes during sustained fire
 * is the most reliable way to produce frame spikes in Babylon, and an automatic weapon at 500 rounds
 * per minute would do exactly that. When a pool is exhausted the oldest entry is recycled, which is
 * invisible in practice and always cheaper than allocating.
 *
 * Pool sizes come from the quality tier. They are fixed at construction rather than grown on demand,
 * so changing tier reallocates once from a menu instead of stuttering mid-fight.
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

const TRACER_LIFE_MS = 70;
const IMPACT_LIFE_MS = 180;
const CASING_LIFE_MS = 2400;

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
  private readonly material: StandardMaterial;

  constructor(scene: Scene, size: number) {
    this.material = new StandardMaterial('tracer', scene);
    this.material.emissiveColor = Color3.FromHexString('#ffe9a8');
    this.material.diffuseColor = Color3.Black();
    this.material.disableLighting = true;
    this.material.alpha = 0.85;

    for (let i = 0; i < size; i++) {
      // A unit-length box along Z, scaled per shot. Cheaper than rebuilding a line mesh.
      const mesh = MeshBuilder.CreateBox(
        `tracer-${i}`,
        { width: 0.03, height: 0.03, depth: 1 },
        scene,
      );
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.entries.push({ mesh, until: 0 });
    }
  }

  spawn(request: TracerRequest, now: number): void {
    if (this.entries.length === 0) return;
    const entry = this.entries[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.entries.length;

    const from = request.from;
    const to = request.to;
    const length = Vector3.Distance(from, to);
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
    this.material.dispose();
  }
}

export class ImpactPool {
  private readonly entries: PooledEntry<Mesh>[] = [];
  private cursor = 0;
  private readonly bodyMaterial: StandardMaterial;
  private readonly worldMaterial: StandardMaterial;

  constructor(scene: Scene, size: number) {
    this.bodyMaterial = new StandardMaterial('impact-body', scene);
    this.bodyMaterial.emissiveColor = Color3.FromHexString('#ff6a6a');
    this.bodyMaterial.diffuseColor = Color3.Black();
    this.bodyMaterial.disableLighting = true;

    this.worldMaterial = new StandardMaterial('impact-world', scene);
    this.worldMaterial.emissiveColor = Color3.FromHexString('#cfd6e4');
    this.worldMaterial.diffuseColor = Color3.Black();
    this.worldMaterial.disableLighting = true;

    for (let i = 0; i < size; i++) {
      const mesh = MeshBuilder.CreatePlane(`impact-${i}`, { size: 0.28 }, scene);
      // Billboard so a flat quad reads as a burst from any viewing angle.
      mesh.billboardMode = 7;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.entries.push({ mesh, until: 0 });
    }
  }

  spawn(request: ImpactRequest, now: number): void {
    if (this.entries.length === 0) return;
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

interface Casing {
  mesh: Mesh;
  until: number;
  velocity: Vector3;
  spin: Vector3;
  bounced: boolean;
}

/**
 * Shell casings.
 *
 * Small brass boxes ejected to the right of the weapon with a tumble and one floor bounce. Purely
 * cosmetic, and out of proportion to its cost in how much it makes automatic fire feel mechanical:
 * without casings a burst is a sound and a flash, with them it is a machine cycling.
 *
 * A size of zero disables them entirely, which is what the Low tier does: a falling mesh per shot is
 * the least valuable thing on screen when frames are scarce.
 */
export class CasingPool {
  private readonly casings: Casing[] = [];
  private cursor = 0;
  private readonly material: StandardMaterial;

  constructor(scene: Scene, size: number) {
    this.material = new StandardMaterial('casing', scene);
    this.material.diffuseColor = Color3.FromHexString('#c9a227');
    this.material.specularColor = new Color3(0.6, 0.5, 0.25);
    this.material.specularPower = 64;

    for (let i = 0; i < size; i++) {
      const mesh = MeshBuilder.CreateBox(
        `casing-${i}`,
        { width: 0.022, height: 0.022, depth: 0.055 },
        scene,
      );
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.casings.push({
        mesh,
        until: 0,
        velocity: new Vector3(),
        spin: new Vector3(),
        bounced: false,
      });
    }
  }

  /** Eject from a position, thrown to the right of the given forward direction. */
  spawn(from: Vector3, forward: Vector3, now: number): void {
    if (this.casings.length === 0) return;
    const casing = this.casings[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.casings.length;

    // Right vector from forward, assuming world up. Casings eject to the right on most weapons.
    const right = Vector3.Cross(Vector3.Up(), forward).normalize();

    casing.mesh.position.copyFrom(from);
    casing.velocity.set(
      right.x * (1.6 + Math.random() * 0.8) + forward.x * 0.4,
      1.4 + Math.random() * 0.7,
      right.z * (1.6 + Math.random() * 0.8) + forward.z * 0.4,
    );
    casing.spin.set(
      (Math.random() * 2 - 1) * 14,
      (Math.random() * 2 - 1) * 14,
      (Math.random() * 2 - 1) * 14,
    );
    casing.bounced = false;
    casing.mesh.visibility = 1;
    casing.mesh.setEnabled(true);
    casing.until = now + CASING_LIFE_MS;
  }

  update(now: number, dt: number): void {
    const step = Math.min(0.05, dt);
    for (const casing of this.casings) {
      if (casing.until === 0) continue;
      if (now >= casing.until) {
        casing.mesh.setEnabled(false);
        casing.until = 0;
        continue;
      }

      casing.velocity.y -= 22 * step;
      casing.mesh.position.addInPlace(casing.velocity.scale(step));
      casing.mesh.rotation.x += casing.spin.x * step;
      casing.mesh.rotation.y += casing.spin.y * step;
      casing.mesh.rotation.z += casing.spin.z * step;

      // One bounce off the floor, then it settles and slides to a stop.
      if (casing.mesh.position.y <= 0.012) {
        casing.mesh.position.y = 0.012;
        if (!casing.bounced) {
          casing.bounced = true;
          casing.velocity.y = Math.abs(casing.velocity.y) * 0.32;
          casing.velocity.x *= 0.5;
          casing.velocity.z *= 0.5;
          casing.spin.scaleInPlace(0.4);
        } else {
          casing.velocity.setAll(0);
          casing.spin.setAll(0);
        }
      }

      // Fade out over the last half second so it does not pop.
      const remaining = casing.until - now;
      casing.mesh.visibility = remaining < 500 ? remaining / 500 : 1;
    }
  }

  dispose(): void {
    for (const casing of this.casings) casing.mesh.dispose();
    this.casings.length = 0;
    this.material.dispose();
  }
}
