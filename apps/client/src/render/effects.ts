/**
 * Tracers, impacts, decals and shell casings.
 *
 * All four are fixed-size pools allocated once. Creating and disposing meshes during sustained fire is the most reliable way
 * to produce frame spikes in Babylon, and an automatic weapon at 500 rounds per minute would do exactly that. When a pool is
 * exhausted the oldest entry is recycled, which is invisible in practice and always cheaper than allocating.
 *
 * Pool sizes come from the quality tier. They are fixed at construction rather than grown on demand, so changing tier
 * reallocates once from a menu instead of stuttering mid-fight.
 *
 * The shot ray comes from the simulation's event, not from a client-side recomputation, so a tracer shows the exact line the
 * bullet travelled, including spread and recoil.
 *
 * ## Fades use visibility, never material alpha
 *
 * A pool shares one material across every entry, so writing `.alpha` during a fade changes every mesh using it. Impacts did
 * that: during sustained fire on a wall, earlier impacts flickered as later ones overwrote the value. `visibility` is a
 * per-mesh property and is the only correct way to fade a pooled entry.
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
/**
 * Decals last far longer than any other effect, because their whole purpose is accumulation: the arena should look like it
 * has been fought in. Twelve seconds outlives a firefight without keeping a full round's worth on screen.
 */
const DECAL_LIFE_MS = 12000;

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
      // Thin out over its life so it reads as a streak rather than a solid rod. Scale, not alpha: shared material.
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
    /*
     * Required for per-mesh visibility to blend. Without it Babylon treats the material as opaque and a visibility below 1
     * either does nothing or thresholds to invisible, so the fade would look like a pop.
     */
    this.bodyMaterial.needAlphaBlending = () => true;

    this.worldMaterial = new StandardMaterial('impact-world', scene);
    this.worldMaterial.emissiveColor = Color3.FromHexString('#cfd6e4');
    this.worldMaterial.diffuseColor = Color3.Black();
    this.worldMaterial.disableLighting = true;
    this.worldMaterial.needAlphaBlending = () => true;

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
    mesh.visibility = 1;
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
      /*
       * Per-mesh visibility, NOT material alpha. The materials are shared across the pool, so writing alpha faded every
       * impact to whatever the most recent one set, and sustained fire on a wall made earlier impacts flicker.
       */
      entry.mesh.visibility = remaining;
    }
  }

  dispose(): void {
    for (const entry of this.entries) entry.mesh.dispose();
    this.entries.length = 0;
    this.bodyMaterial.dispose();
    this.worldMaterial.dispose();
  }
}

/**
 * Bullet decals.
 *
 * The cheapest thing that makes an arena look fought in. An impact flash says a bullet arrived; a decal says thirty of them
 * did, and the wall you have been using as cover shows it.
 *
 * Oriented to the surface rather than billboarded. A billboarded decal on a wall reads as a sticker turning to face the
 * player, which is worse than no decal. The normal is derived from the shot direction, which is an approximation: the true
 * surface normal is known to the simulation's raycast but is not in the event, and for an axis-aligned greybox the incoming
 * direction is close enough that the difference is not visible.
 *
 * A size of zero disables them, which is what the Low tier does.
 */
export class DecalPool {
  private readonly entries: PooledEntry<Mesh>[] = [];
  private cursor = 0;
  private readonly material: StandardMaterial;

  constructor(scene: Scene, size: number) {
    this.material = new StandardMaterial('decal', scene);
    this.material.diffuseColor = Color3.FromHexString('#0a0c10');
    this.material.specularColor = Color3.Black();
    // Unlit: a decal that catches the directional light looks like a floating plane rather than a mark on a surface.
    this.material.disableLighting = true;
    this.material.emissiveColor = Color3.FromHexString('#0a0c10');
    this.material.needAlphaBlending = () => true;
    /*
     * Pull toward the camera in the depth buffer so the decal does not z-fight with the surface it sits on. Offsetting the
     * position along the normal would also work but leaves a visible gap at grazing angles.
     */
    this.material.zOffset = -2;

    for (let i = 0; i < size; i++) {
      const mesh = MeshBuilder.CreatePlane(`decal-${i}`, { size: 0.16 }, scene);
      mesh.isPickable = false;
      mesh.setEnabled(false);
      mesh.material = this.material;
      this.entries.push({ mesh, until: 0 });
    }
  }

  /**
   * Mark a surface at a hit point.
   *
   * `direction` is the bullet's travel direction; the decal faces back along it.
   */
  spawn(at: Vector3, direction: Vector3, now: number): void {
    if (this.entries.length === 0) return;
    const entry = this.entries[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.entries.length;

    const mesh = entry.mesh;
    mesh.position.copyFrom(at);
    // Face back along the incoming ray, so the plane lies against the surface it hit.
    mesh.lookAt(at.subtract(direction));
    // Vary the size and roll a little, so a burst does not look like a stencil applied five times.
    const scale = 0.8 + Math.random() * 0.5;
    mesh.scaling.setAll(scale);
    mesh.rotate(Vector3.Forward(), Math.random() * Math.PI * 2);
    mesh.visibility = 1;
    mesh.setEnabled(true);
    entry.until = now + DECAL_LIFE_MS;
  }

  update(now: number): void {
    for (const entry of this.entries) {
      if (entry.until === 0) continue;
      if (now >= entry.until) {
        entry.mesh.setEnabled(false);
        entry.until = 0;
        continue;
      }
      // Fade over the last two seconds only, so marks persist and then leave quietly.
      const remaining = entry.until - now;
      entry.mesh.visibility = remaining < 2000 ? remaining / 2000 : 1;
    }
  }

  dispose(): void {
    for (const entry of this.entries) entry.mesh.dispose();
    this.entries.length = 0;
    this.material.dispose();
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
    this.material.needAlphaBlending = () => true;

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

      // Fade out over the last half second so it does not pop. Per-mesh, like every other fade here.
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
