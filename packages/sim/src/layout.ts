/**
 * The greybox arena, defined once.
 *
 * This is the single source of truth for both the collision boxes the simulation uses and the
 * meshes the renderer draws. Defining the arena twice (Babylon primitives in one file, collision
 * brushes in another) is how invisible walls and shoot-through cover happen, so the renderer reads
 * this list rather than declaring its own.
 *
 * When the content pipeline lands (WO-7) this is replaced by a `collision.bin` extracted from the
 * source glTF at build time, which enforces the same property for authored maps.
 */

import { boxFromCentre, createCollisionWorld, type BoxFx, type CollisionWorld } from './collision.js';
import * as fx from './math/fixed.js';

/** Half the width of the square arena, in world units. */
export const ARENA_HALF = 30;
export const WALL_HEIGHT = 6;

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
  kind: 'wall' | 'coverLow' | 'coverHigh' | 'platform';
}

/**
 * Every solid in the arena. Ramps from the first draft are gone: a sloped box collides as its
 * bounding box, so it would have read as an invisible step. Stacked platforms give the same
 * height advantage and behave exactly as they look.
 */
export const GREYBOX_BRUSHES: readonly BrushDescriptor[] = [
  // Perimeter
  { name: 'wallN', x: 0, y: WALL_HEIGHT / 2, z: ARENA_HALF, width: ARENA_HALF * 2, height: WALL_HEIGHT, depth: 1, kind: 'wall' },
  { name: 'wallS', x: 0, y: WALL_HEIGHT / 2, z: -ARENA_HALF, width: ARENA_HALF * 2, height: WALL_HEIGHT, depth: 1, kind: 'wall' },
  { name: 'wallE', x: ARENA_HALF, y: WALL_HEIGHT / 2, z: 0, width: 1, height: WALL_HEIGHT, depth: ARENA_HALF * 2, kind: 'wall' },
  { name: 'wallW', x: -ARENA_HALF, y: WALL_HEIGHT / 2, z: 0, width: 1, height: WALL_HEIGHT, depth: ARENA_HALF * 2, kind: 'wall' },

  // Centre structure: low ring you can shoot over, with a raised middle to contest.
  { name: 'centreLowW', x: -4, y: 0.6, z: 0, width: 2, height: 1.2, depth: 8, kind: 'coverLow' },
  { name: 'centreLowE', x: 4, y: 0.6, z: 0, width: 2, height: 1.2, depth: 8, kind: 'coverLow' },
  { name: 'centreStep', x: 0, y: 0.3, z: 0, width: 6, height: 0.6, depth: 6, kind: 'platform' },
  { name: 'centreTop', x: 0, y: 0.9, z: 0, width: 3, height: 1.8, depth: 3, kind: 'platform' },

  // Chest-high cover, four quadrants.
  { name: 'coverNW', x: -12, y: 0.6, z: 10, width: 5, height: 1.2, depth: 2, kind: 'coverLow' },
  { name: 'coverNE', x: 12, y: 0.6, z: 10, width: 5, height: 1.2, depth: 2, kind: 'coverLow' },
  { name: 'coverSW', x: -12, y: 0.6, z: -10, width: 5, height: 1.2, depth: 2, kind: 'coverLow' },
  { name: 'coverSE', x: 12, y: 0.6, z: -10, width: 5, height: 1.2, depth: 2, kind: 'coverLow' },

  // Tall blocks that break sight lines across the long axes.
  { name: 'pillarW', x: -20, y: 1.5, z: 0, width: 3, height: 3, depth: 8, kind: 'coverHigh' },
  { name: 'pillarE', x: 20, y: 1.5, z: 0, width: 3, height: 3, depth: 8, kind: 'coverHigh' },
  { name: 'pillarN', x: 0, y: 1.5, z: 20, width: 8, height: 3, depth: 3, kind: 'coverHigh' },
  { name: 'pillarS', x: 0, y: 1.5, z: -20, width: 8, height: 3, depth: 3, kind: 'coverHigh' },

  // Staircases onto the tall blocks, as stacked steps so each one is climbable by step-up.
  { name: 'stepA1', x: -20, y: 0.3, z: 6, width: 3, height: 0.6, depth: 1.5, kind: 'platform' },
  { name: 'stepA2', x: -20, y: 0.9, z: 7.5, width: 3, height: 1.8, depth: 1.5, kind: 'platform' },
  { name: 'stepA3', x: -20, y: 1.5, z: 9, width: 3, height: 3, depth: 1.5, kind: 'platform' },
  { name: 'stepB1', x: 20, y: 0.3, z: -6, width: 3, height: 0.6, depth: 1.5, kind: 'platform' },
  { name: 'stepB2', x: 20, y: 0.9, z: -7.5, width: 3, height: 1.8, depth: 1.5, kind: 'platform' },
  { name: 'stepB3', x: 20, y: 1.5, z: -9, width: 3, height: 3, depth: 1.5, kind: 'platform' },
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

/** Player spawn points, in stable order. WaveScheduler (WO-42) picks enemy spawns separately. */
export const GREYBOX_SPAWNS: readonly { x: number; z: number; yaw: number }[] = [
  { x: 0, z: -24, yaw: 0 },
  { x: 0, z: 24, yaw: 0.5 },
  { x: -24, z: 0, yaw: 0.25 },
  { x: 24, z: 0, yaw: 0.75 },
];
