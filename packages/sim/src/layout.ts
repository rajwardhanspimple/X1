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
 * Six brushes in a fixed order. The climb, read down the `y` column below, is:
 *
 *     ground 0 -> g0 top 1.3 -> g1 top 2.6 -> s2 top 3.9 -> s3 top 5.2
 *
 * No rise exceeds CRATE, which is the property this function exists to guarantee. Heights are stated on each brush rather than
 * derived, so that column is checkable by eye.
 *
 * `access` is the side the stair is on. The footprint runs 5 units from the centre away from the stair and 9 toward it, so a tower
 * needs about 14 units of room along its axis.
 *
 * The orientations are handled by two small helpers rather than a rotation matrix: a rotation would have to swap the width/depth pair
 * as well as the offsets, and getting that subtly wrong produces cover whose visual does not match its collision.
 */
function tower(
  id: string,
  x: number,
  z: number,
  access: 'north' | 'south' | 'east' | 'west',
): BrushDescriptor[] {
  /** True when the tower's long axis runs north-south. Decides which of width/depth is the length. */
  const ns = access === 'north' || access === 'south';
  /** Which way along that axis the stair extends. */
  const sign = access === 'north' || access === 'east' ? 1 : -1;

  /** Position at an offset along the tower's axis, measured from the centre toward the stair. */
  const at = (offset: number) => (ns ? { x, z: z + offset * sign } : { x: x + offset * sign, z });

  /** Width and depth for a given length along the axis. */
  const span = (length: number) =>
    ns ? { width: CONTAINER_W, depth: length } : { width: length, depth: CONTAINER_W };

  return [
    // Lower container. Top at 2.6, walkable, with its far end clear of the upper one.
    {
      name: `${id}-lo`,
      ...at(0),
      y: CONTAINER_H / 2,
      height: CONTAINER_H,
      ...span(10),
      kind: 'coverHigh',
    },
    // Upper container. Top at 5.2: the high ground this tower exists to provide.
    {
      name: `${id}-hi`,
      ...at(-1),
      y: CONTAINER_H * 1.5,
      height: CONTAINER_H,
      ...span(4),
      kind: 'platform',
    },
    // Last step up, standing on the lower container. Top at 5.2, level with the upper container.
    {
      name: `${id}-s3`,
      ...at(2.75),
      y: CONTAINER_H + CRATE * 1.5,
      height: CRATE,
      ...span(1.5),
      kind: 'platform',
    },
    // First step on the lower container. Top at 3.9.
    {
      name: `${id}-s2`,
      ...at(4.25),
      y: CONTAINER_H + CRATE / 2,
      height: CRATE,
      ...span(1.5),
      kind: 'coverLow',
    },
    // Ground step reaching the lower container's top. Top at 2.6.
    {
      name: `${id}-g1`,
      ...at(6),
      y: CONTAINER_H / 2,
      height: CONTAINER_H,
      ...span(2),
      kind: 'coverHigh',
    },
    // First step from the floor. Top at 1.3.
    {
      name: `${id}-g0`,
      ...at(8),
      y: CRATE / 2,
      height: CRATE,
      ...span(2),
      kind: 'coverLow',
    },
  ];
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
