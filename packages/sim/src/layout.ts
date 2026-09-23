/**
 * The arena, defined once.
 *
 * This is the single source of truth for both the collision boxes the simulation uses and the meshes the renderer draws. Defining
 * the arena twice (Babylon primitives in one file, collision brushes in another) is how invisible walls and shoot-through cover
 * happen, so the renderer reads this list rather than declaring its own.
 *
 * ## Why a container yard
 *
 * Collision is axis-aligned boxes with no ramps, because a sloped box collides as its bounding box and a visual ramp would read as
 * an invisible step. That reads as a limitation until you ask what else is built entirely from axis-aligned boxes, and the answer is
 * a shipping container yard. Containers, crates and pallet stacks are cuboids at standard sizes, they stack, and they suit a
 * military setting.
 *
 * So the geometry the simulation can represent exactly is the geometry the arena is made of. Nothing is faked and nothing collides
 * differently from how it looks.
 *
 * Sizes follow real containers, rounded to convenient numbers: 2.4 wide, 2.6 tall, 6 or 12 long. The 2.6 is a gameplay number as
 * much as a visual one, because it sits above standing eye height. One container is full cover; two stacked are high ground.
 *
 * ## Reachability is guaranteed by construction
 *
 * Every piece of high ground comes from `tower()`, which emits the stack and its access steps together. Placing steps by hand means
 * verifying by arithmetic that no rise exceeds a jump and that nothing overlaps, which is error-prone enough that it went wrong
 * several times while this was being written. A generator cannot produce unreachable high ground, because the steps are part of what
 * a tower is.
 *
 * Every rise is CRATE (1.3), half a container. A pallet stack in fiction, a comfortable step in practice.
 *
 * When the content pipeline lands (WO-7) this is replaced by a `collision.bin` extracted from the source glTF at build time, which
 * enforces the same property for authored maps.
 */

import {
  boxFromCentre,
  createCollisionWorld,
  type BoxFx,
  type CollisionWorld,
} from './collision.js';
import * as fx from './math/fixed.js';
import type { Vec3Fx } from './state.js';

/** Half the width of the square arena, in world units. */
export const ARENA_HALF = 32;
/** Perimeter wall height. Tall enough that a two-container stack does not look like it clears a fence. */
export const WALL_HEIGHT = 8;

/** Standard container dimensions, rounded. Height is above standing eye level, so one is full cover. */
const CONTAINER_W = 2.4;
const CONTAINER_H = 2.6;
/** Half a container. Every climbable rise in the arena is exactly this. */
const CRATE = 1.3;

/** Plain-number description, for the renderer to build meshes from. */
export interface BrushDescriptor {
  name: string;
  /** Centre position. */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  /**
   * Surface family, for the renderer's material choice.
   *
   * Deliberately still the original four values rather than a container-specific vocabulary: the renderer already switches on these,
   * and the mapping is natural. A container is coverHigh (full cover), a crate is coverLow (waist high), an upper stack is a
   * platform (stand on it), the perimeter is wall.
   */
  kind: 'wall' | 'coverLow' | 'coverHigh' | 'platform';
}

/**
 * A container stack with its own access stair.
 *
 * Emits six brushes in a fixed order: the lower container, the upper container, two steps on top of the lower one, and two ground
 * steps leading to it. The climb is 0 to 1.3 to 2.6 to 3.9 to 5.2, so no single rise exceeds CRATE.
 *
 * `access` is the side the stair is on. The footprint extends 5 units from the centre away from the stair and 9 units toward it, so a
 * tower needs 14 units of room along its axis.
 *
 * The four orientations are written out rather than derived from a rotation, because a rotation helper would have to rotate the
 * width/depth pair as well as the offsets, and getting that subtly wrong produces cover that does not match its collision.
 */
function tower(
  id: string,
  x: number,
  z: number,
  access: 'north' | 'south' | 'east' | 'west',
): BrushDescriptor[] {
  // Offsets along the tower's axis, measured from the centre toward the access side.
  const lo = 0;
  const hi = -1;
  const step3 = 2.75;
  const step2 = 4.25;
  const ground1 = 6;
  const ground0 = 8;

  /** Along the axis, and across it. Depth and width swap for the east-west orientations. */
  const ns = access === 'north' || access === 'south';
  const sign = access === 'north' || access === 'east' ? 1 : -1;

  const at = (offset: number) =>
    ns ? { x, z: z + offset * sign } : { x: x + offset * sign, z };

  const along = (depth: number) =>
    ns
      ? { width: CONTAINER_W, depth }
      : { width: depth, depth: CONTAINER_W };

  const p = {
    lo: at(lo),
    hi: at(hi),
    step3: at(step3),
    step2: at(step2),
    ground1: at(ground1),
    ground0: at(ground0),
  };

  return [
    // The lower container. Its top at 2.6 is walkable, and the ends stay clear of the upper one.
    { name: `${id}-lo`, ...p.lo, y: CONTAINER_H / 2, ...along(10), kind: 'coverHigh' },
    // The upper container. Top at 5.2: the high ground this tower exists to provide.
    { name: `${id}-hi`, ...p.hi, y: CONTAINER_H * 1.5, ...along(4), kind: 'platform' },
    // Two steps standing on the lower container's exposed top, climbing to the upper one.
    { name: `${id}-s3`, ...p.step3, y: CONTAINER_H * 1.5, ...along(1.5), kind: 'platform' },
    { name: `${id}-s2`, ...p.step2, y: CONTAINER_H + CRATE / 2, ...along(1.5), kind: 'coverLow' },
    // Two ground steps reaching the lower container's top.
    { name: `${id}-g1`, ...p.ground1, y: CONTAINER_H / 2, ...along(2), kind: 'coverHigh' },
    { name: `${id}-g0`, ...p.ground0, y: CRATE / 2, ...along(2), kind: 'coverLow' },
  ].map((b) => ({
    ...b,
    height:
      b.name.endsWith('-g0') || b.name.endsWith('-s2')
        ? b.name.endsWith('-g0')
          ? CRATE
          : CRATE
        : CONTAINER_H,
  })) as BrushDescriptor[];
}

/** A single container lying on the ground. Full cover, not climbable without help. */
function container(
  name: string,
  x: number,
  z: number,
  length: number,
  axis: 'ns' | 'ew',
): BrushDescriptor {
  return {
    name,
    x,
    y: CONTAINER_H / 2,
    z,
    width: axis === 'ns' ? CONTAINER_W : length,
    height: CONTAINER_H,
    depth: axis === 'ns' ? length : CONTAINER_W,
    kind: 'coverHigh',
  };
}

/** A crate stack. Waist-high: shoot over it standing, hide behind it crouching, climb it. */
function crate(name: string, x: number, z: number, size = 3): BrushDescriptor {
  return {
    name,
    x,
    y: CRATE / 2,
    z,
    width: size,
    height: CRATE,
    depth: size,
    kind: 'coverLow',
  };
}

/**
 * Every solid in the arena, in a stable order.
 *
 * Order is part of the outcome: collision iterates this list, and the renderer draws it. Appending is safe, reordering is not.
 *
 * ## The layout, and why
 *
 * Two towers flank the centre and form a corridor between them. That corridor is the shortest path from one half of the arena to the
 * other, and it is overlooked from both stacks, so taking it is fast and exposed. An arena wants at least one choice of that shape.
 *
 * Four quadrant towers give every corner its own high ground. Their stairs face outward, away from the centre, so holding one means
 * your access route is behind you.
 *
 * Long container rows near each wall break the perimeter sightline. Without them, running the edge of the arena is one clear lane
 * from corner to corner, which is both boring and unfairly safe.
 *
 * Loose crates fill the gaps at waist height, so crossing open ground is never completely without options.
 */
export const GREYBOX_BRUSHES: readonly BrushDescriptor[] = [
  // --- Perimeter ---------------------------------------------------------------------------------
  { name: 'wall-n', x: 0, y: WALL_HEIGHT / 2, z: ARENA_HALF, width: ARENA_HALF * 2, height: WALL_HEIGHT, depth: 1, kind: 'wall' },
  { name: 'wall-s', x: 0, y: WALL_HEIGHT / 2, z: -ARENA_HALF, width: ARENA_HALF * 2, height: WALL_HEIGHT, depth: 1, kind: 'wall' },
  { name: 'wall-e', x: ARENA_HALF, y: WALL_HEIGHT / 2, z: 0, width: 1, height: WALL_HEIGHT, depth: ARENA_HALF * 2, kind: 'wall' },
  { name: 'wall-w', x: -ARENA_HALF, y: WALL_HEIGHT / 2, z: 0, width: 1, height: WALL_HEIGHT, depth: ARENA_HALF * 2, kind: 'wall' },

  // --- Centre: twin stacks forming a corridor ----------------------------------------------------
  // Access faces opposite ways, so the two high grounds are entered from opposite halves of the arena.
  ...tower('ctr-w', -5, 0, 'north'),
  ...tower('ctr-e', 5, 0, 'south'),

  // --- Quadrant towers, stairs facing outward ----------------------------------------------------
  ...tower('nw', -20, 13, 'north'),
  ...tower('ne', 20, 13, 'north'),
  ...tower('sw', -20, -13, 'south'),
  ...tower('se', 20, -13, 'south'),

  // --- Container rows breaking the perimeter lanes -----------------------------------------------
  container('row-n', 0, 25, 18, 'ew'),
  container('row-s', 0, -25, 18, 'ew'),
  container('row-e', 27, 0, 18, 'ns'),
  container('row-w', -27, 0, 18, 'ns'),

  // --- Loose crates ------------------------------------------------------------------------------
  crate('crate-nw', -12, 7),
  crate('crate-ne', 12, 7),
  crate('crate-sw', -12, -7),
  crate('crate-se', 12, -7),
  crate('crate-n', 0, 16, 4),
  crate('crate-s', 0, -16, 4),
  crate('crate-w', -28, 14, 2.5),
  crate('crate-e', 28, -14, 2.5),
];


function toBox(b: BrushDescriptor): BoxFx {
  return boxFromCentre(
    fx.fromRatio(Math.round(b.x * 1000), 1000),
    fx.fromRatio(Math.round(b.y * 1000), 1000),
    fx.fromRatio(Math.round(b.z * 1000), 1000),
    fx.fromRatio(Math.round(b.width * 500), 1000),
    fx.fromRatio(Math.round(b.height * 500), 1000),
    fx.fromRatio(Math.round(b.depth * 500), 1000),
  );
}

/** Build the collision world. Box order follows GREYBOX_BRUSHES and must stay stable. */
export function createGreyboxWorld(): CollisionWorld {
  const boxes = GREYBOX_BRUSHES.map(toBox);
  const bounds: BoxFx = {
    minX: fx.fromInt(-ARENA_HALF),
    minY: 0,
    minZ: fx.fromInt(-ARENA_HALF),
    maxX: fx.fromInt(ARENA_HALF),
    maxY: fx.fromInt(WALL_HEIGHT * 4),
    maxZ: fx.fromInt(ARENA_HALF),
  };
  return createCollisionWorld(boxes, bounds);
}

/**
 * Player spawn points, in stable order. Index 0 is where a round begins.
 *
 * At the four mid-edges facing the centre, so a round opens looking down the arena's long axis rather than at a wall.
 */
export const GREYBOX_SPAWNS: readonly { x: number; z: number; yaw: number }[] = [
  { x: 0, z: -29, yaw: 0 },
  { x: 0, z: 29, yaw: 0.5 },
  { x: -29, z: 0, yaw: 0.25 },
  { x: 29, z: 0, yaw: 0.75 },
];

/**
 * Enemy spawn points.
 *
 * In the corners and behind the container rows, so a wave arrives from cover rather than appearing in the open. The wave scheduler
 * picks the furthest points from the player first, so these are candidates rather than a rotation.
 */
export const GREYBOX_ENEMY_SPAWNS: readonly { x: number; z: number }[] = [
  { x: -29, z: -29 },
  { x: 29, z: -29 },
  { x: -29, z: 29 },
  { x: 29, z: 29 },
  { x: -16, z: 28 },
  { x: 16, z: -28 },
  { x: -28, z: -16 },
  { x: 28, z: 16 },
];

function toVec(p: { x: number; z: number }): Vec3Fx {
  return { x: fx.fromInt(p.x), y: 0, z: fx.fromInt(p.z) };
}

export function greyboxPlayerSpawns(): Vec3Fx[] {
  return GREYBOX_SPAWNS.map(toVec);
}

export function greyboxEnemySpawns(): Vec3Fx[] {
  return GREYBOX_ENEMY_SPAWNS.map(toVec);
}
