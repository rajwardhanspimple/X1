/**
 * CollisionWorld: what the simulation considers solid.
 *
 * Shapes are axis-aligned boxes and the player is a vertical box (a capsule approximated by its
 * bounding box). That is a deliberate narrowing: every brush in a greybox arena is axis aligned,
 * and box-against-box overlap in fixed point is exact integer comparison with no square roots and
 * no normalisation, so it is both fast and trivially identical across engines. When real map
 * geometry arrives through the content pipeline (WO-7) a triangle-soup BVH will back this same
 * interface.
 *
 * Nothing here reads the renderer. The boxes come from SimContent, so the server sees exactly the
 * same world the browser did.
 */

import * as fx from './math/fixed.js';
import type { Vec3Fx } from './state.js';

/** Axis-aligned box in fixed point, stored as min and max corners. */
export interface BoxFx {
  minX: fx.Fx;
  minY: fx.Fx;
  minZ: fx.Fx;
  maxX: fx.Fx;
  maxY: fx.Fx;
  maxZ: fx.Fx;
}

export function boxFromCentre(
  cx: fx.Fx,
  cy: fx.Fx,
  cz: fx.Fx,
  halfX: fx.Fx,
  halfY: fx.Fx,
  halfZ: fx.Fx,
): BoxFx {
  return {
    minX: (cx - halfX) | 0,
    minY: (cy - halfY) | 0,
    minZ: (cz - halfZ) | 0,
    maxX: (cx + halfX) | 0,
    maxY: (cy + halfY) | 0,
    maxZ: (cz + halfZ) | 0,
  };
}

/** The moving body: a box described by its foot position, half width and height. */
export interface BodyShape {
  halfWidth: fx.Fx;
  height: fx.Fx;
}

function bodyBox(pos: Vec3Fx, shape: BodyShape): BoxFx {
  return {
    minX: (pos.x - shape.halfWidth) | 0,
    minY: pos.y,
    minZ: (pos.z - shape.halfWidth) | 0,
    maxX: (pos.x + shape.halfWidth) | 0,
    maxY: (pos.y + shape.height) | 0,
    maxZ: (pos.z + shape.halfWidth) | 0,
  };
}

function overlaps(a: BoxFx, b: BoxFx): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}

export interface CollisionWorld {
  /** Solid boxes, in stable order. Order is part of the outcome, so never sort at runtime. */
  readonly boxes: readonly BoxFx[];
  /** Outer bounds of the playable area, used to keep a body inside the arena. */
  readonly bounds: BoxFx;
}

export function createCollisionWorld(boxes: readonly BoxFx[], bounds: BoxFx): CollisionWorld {
  return { boxes, bounds };
}

export interface MoveResult {
  pos: Vec3Fx;
  /** Per-axis contact flags, so the caller can zero the matching velocity component. */
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  grounded: boolean;
}

/** How high a body may be lifted to clear a low ledge while walking. About 0.35 units. */
const STEP_HEIGHT: fx.Fx = fx.fromRatio(35, 100);
/** Downward probe used to decide ground contact. Small, so a body does not snap from mid-air. */
const GROUND_PROBE: fx.Fx = fx.fromRatio(4, 100);

function collides(world: CollisionWorld, box: BoxFx): boolean {
  for (let i = 0; i < world.boxes.length; i++) {
    if (overlaps(box, world.boxes[i]!)) return true;
  }
  return false;
}

/**
 * Try to move by delta on one axis. Returns the accepted position component.
 *
 * A blocked axis is resolved by bisection rather than by a closed-form sweep: at fixed-point
 * resolution twelve halvings land within 1/4096 of a unit, the loop count is constant so it cannot
 * diverge between engines, and it needs no division.
 */
function sweepAxis(
  world: CollisionWorld,
  pos: Vec3Fx,
  shape: BodyShape,
  axis: 'x' | 'y' | 'z',
  delta: fx.Fx,
): { value: fx.Fx; blocked: boolean } {
  if (delta === 0) return { value: pos[axis], blocked: false };

  const start = pos[axis];
  const probe: Vec3Fx = { x: pos.x, y: pos.y, z: pos.z };
  probe[axis] = (start + delta) | 0;
  if (!collides(world, bodyBox(probe, shape))) {
    return { value: probe[axis], blocked: false };
  }

  // Binary search for the last free position along the axis.
  let lo = 0;
  let hi = delta;
  for (let i = 0; i < 12; i++) {
    const mid = ((lo + hi) / 2) | 0;
    probe[axis] = (start + mid) | 0;
    if (collides(world, bodyBox(probe, shape))) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { value: (start + lo) | 0, blocked: true };
}

/**
 * Move a body by a delta, resolving contacts.
 *
 * Axes are swept separately and in a fixed order (X, then Z, then Y). Sweeping the whole vector at
 * once would stop all movement when any component is blocked, which reads as sticking to walls;
 * per-axis sweeping produces sliding, which is what a player expects. The order is part of the
 * simulation outcome and must not change without a simVersion bump.
 */
export function resolveMove(
  world: CollisionWorld,
  pos: Vec3Fx,
  shape: BodyShape,
  delta: Vec3Fx,
  allowStepUp: boolean,
): MoveResult {
  const next: Vec3Fx = { x: pos.x, y: pos.y, z: pos.z };

  const sweptX = sweepAxis(world, next, shape, 'x', delta.x);
  next.x = sweptX.value;
  let hitX = sweptX.blocked;

  const sweptZ = sweepAxis(world, next, shape, 'z', delta.z);
  next.z = sweptZ.value;
  let hitZ = sweptZ.blocked;

  /*
   * Step-up: if horizontal movement was blocked, retry it lifted by the step height. This is what
   * lets a player walk onto the low cover blocks without jumping. It is capped by STEP_HEIGHT and
   * only attempted when the body is moving along the ground, so it cannot be used to climb a wall.
   */
  if (allowStepUp && (hitX || hitZ)) {
    const lifted: Vec3Fx = { x: pos.x, y: (pos.y + STEP_HEIGHT) | 0, z: pos.z };
    if (!collides(world, bodyBox(lifted, shape))) {
      const stepX = sweepAxis(world, lifted, shape, 'x', delta.x);
      lifted.x = stepX.value;
      const stepZ = sweepAxis(world, lifted, shape, 'z', delta.z);
      lifted.z = stepZ.value;
      // Only accept the step if it actually made more horizontal progress.
      const gainedX = fx.abs((lifted.x - pos.x) | 0) > fx.abs((next.x - pos.x) | 0);
      const gainedZ = fx.abs((lifted.z - pos.z) | 0) > fx.abs((next.z - pos.z) | 0);
      if (gainedX || gainedZ) {
        // Settle back down onto the ledge.
        const settle = sweepAxis(world, lifted, shape, 'y', -STEP_HEIGHT);
        next.x = lifted.x;
        next.z = lifted.z;
        next.y = settle.value;
        hitX = stepX.blocked;
        hitZ = stepZ.blocked;
      }
    }
  }

  const sweptY = sweepAxis(world, next, shape, 'y', delta.y);
  next.y = sweptY.value;
  const hitY = sweptY.blocked;

  // Keep the body inside the arena bounds regardless of brush coverage.
  next.x = fx.clamp(
    next.x,
    (world.bounds.minX + shape.halfWidth) | 0,
    (world.bounds.maxX - shape.halfWidth) | 0,
  );
  next.z = fx.clamp(
    next.z,
    (world.bounds.minZ + shape.halfWidth) | 0,
    (world.bounds.maxZ - shape.halfWidth) | 0,
  );
  if (next.y < world.bounds.minY) next.y = world.bounds.minY;

  /*
   * Ground contact is its own probe rather than a by-product of the Y sweep. Deriving it from the
   * sweep makes standing on an edge flicker between grounded and airborne as the body settles.
   */
  const grounded = isGrounded(world, next, shape);

  return { pos: next, hitX, hitY, hitZ, grounded };
}

export function isGrounded(world: CollisionWorld, pos: Vec3Fx, shape: BodyShape): boolean {
  if (pos.y <= world.bounds.minY) return true;
  const probe: Vec3Fx = { x: pos.x, y: (pos.y - GROUND_PROBE) | 0, z: pos.z };
  return collides(world, bodyBox(probe, shape));
}

export function pointInSolid(world: CollisionWorld, p: Vec3Fx): boolean {
  const point: BoxFx = { minX: p.x, minY: p.y, minZ: p.z, maxX: p.x, maxY: p.y, maxZ: p.z };
  for (let i = 0; i < world.boxes.length; i++) {
    const b = world.boxes[i]!;
    if (
      point.minX >= b.minX &&
      point.maxX <= b.maxX &&
      point.minY >= b.minY &&
      point.maxY <= b.maxY &&
      point.minZ >= b.minZ &&
      point.maxZ <= b.maxZ
    ) {
      return true;
    }
  }
  return false;
}

export interface RayHit {
  /** Distance along the ray, in fixed point. */
  distance: fx.Fx;
  point: Vec3Fx;
  boxIndex: number;
}

/**
 * Ray against the box set, for hitscan weapons (WO-39) and enemy line of sight (WO-42).
 *
 * Slab method with fixed-point arithmetic. Returns the nearest hit within maxDistance, or null.
 * dir does not need to be normalised; distance is then in units of dir length, so callers pass a
 * unit direction when they need real distance.
 */
export function raycast(
  world: CollisionWorld,
  origin: Vec3Fx,
  dir: Vec3Fx,
  maxDistance: fx.Fx,
): RayHit | null {
  let bestT: fx.Fx = maxDistance;
  let bestIndex = -1;

  for (let i = 0; i < world.boxes.length; i++) {
    const b = world.boxes[i]!;
    let tMin: fx.Fx = 0;
    let tMax: fx.Fx = maxDistance;
    let miss = false;

    // One slab per axis, unrolled so there is no array indexing on the hot path.
    for (let axis = 0; axis < 3 && !miss; axis++) {
      const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
      const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
      const lo = axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ;
      const hi = axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ;

      if (d === 0) {
        // Parallel to this slab: either always inside it or never.
        if (o < lo || o > hi) miss = true;
        continue;
      }
      let t1 = fx.div((lo - o) | 0, d);
      let t2 = fx.div((hi - o) | 0, d);
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) miss = true;
    }

    if (!miss && tMin >= 0 && tMin < bestT) {
      bestT = tMin;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return null;
  return {
    distance: bestT,
    point: {
      x: (origin.x + fx.mul(dir.x, bestT)) | 0,
      y: (origin.y + fx.mul(dir.y, bestT)) | 0,
      z: (origin.z + fx.mul(dir.z, bestT)) | 0,
    },
    boxIndex: bestIndex,
  };
}
