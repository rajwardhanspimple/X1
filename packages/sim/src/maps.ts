/** Built-in arena catalogue shared by the client, renderer and verifier. */
import type { MatchConfig } from '@rearena/protocol';
import { boxFromCentre, createCollisionWorld, type CollisionWorld } from './collision.js';
import type { SimContent } from './kernel.js';
import {
  ARENA_HALF,
  WALL_HEIGHT,
  GREYBOX_BRUSHES,
  GREYBOX_SPAWNS,
  GREYBOX_ENEMY_SPAWNS,
  createGreyboxWorld,
  type BrushDescriptor,
} from './layout.js';
import * as fx from './math/fixed.js';
import type { Vec3Fx } from './state.js';

export interface MapBrush extends BrushDescriptor {
  /** Presentation only. Collision always uses the dimensions of the brush. */
  surface?: 'sandbag' | 'concrete' | 'building' | 'vehicle' | 'metal' | 'crate';
}

export interface ArenaSpawn {
  x: number;
  z: number;
  y?: number;
  yaw: number;
}

export interface ArenaMap {
  id: string;
  name: string;
  detail: string;
  /** Content revision. Change this whenever this map's geometry or spawns change. */
  hash: string;
  halfSize: number;
  wallHeight: number;
  theme: 'yard' | 'outpost' | 'urban';
  brushes: readonly MapBrush[];
  spawns: readonly ArenaSpawn[];
  enemySpawns: readonly { x: number; z: number; y?: number }[];
}

function box(
  name: string,
  x: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  surface: NonNullable<MapBrush['surface']>,
  base = 0,
  kind: BrushDescriptor['kind'] = 'coverHigh',
): MapBrush {
  return { name, x, y: base + height / 2, z, width, height, depth, kind, surface };
}

function perimeter(half: number, height: number): MapBrush[] {
  return [
    box('wall-n', 0, half, half * 2, height, 1, 'concrete', 0, 'wall'),
    box('wall-s', 0, -half, half * 2, height, 1, 'concrete', 0, 'wall'),
    box('wall-e', half, 0, 1, height, half * 2, 'concrete', 0, 'wall'),
    box('wall-w', -half, 0, 1, height, half * 2, 'concrete', 0, 'wall'),
  ];
}

/** Two opposing doorways avoid a dead-end interior. The roof is a real collision slab. */
function bunker(id: string, x: number, z: number): MapBrush[] {
  return [
    box(`${id}-west`, x - 5.5, z, 1, 3, 10, 'concrete'),
    box(`${id}-east`, x + 5.5, z, 1, 3, 10, 'concrete'),
    box(`${id}-nw`, x - 4, z + 4.5, 4, 3, 1, 'concrete'),
    box(`${id}-ne`, x + 4, z + 4.5, 4, 3, 1, 'concrete'),
    box(`${id}-sw`, x - 4, z - 4.5, 4, 3, 1, 'concrete'),
    box(`${id}-se`, x + 4, z - 4.5, 4, 3, 1, 'concrete'),
    box(`${id}-roof`, x, z, 12, 0.4, 10, 'concrete', 3, 'platform'),
  ];
}

/** Each riser is 0.25 units, below the controller's 0.35 step limit. */
function lookout(id: string, x: number, z: number, height: number): MapBrush[] {
  const steps = Math.round(height / 0.25);
  const brushes: MapBrush[] = [
    box(`${id}-deck`, x, z, 6, 0.4, 6, 'metal', height - 0.4, 'platform'),
  ];
  for (const dx of [-2.5, 2.5]) {
    for (const dz of [-2.5, 2.5]) {
      brushes.push(box(`${id}-post-${dx}-${dz}`, x + dx, z + dz, 0.5, height - 0.4, 0.5, 'metal'));
    }
  }
  for (let i = 0; i < steps; i++) {
    brushes.push(
      box(`${id}-step-${i}`, x, z + 3 + (steps - i - 0.5) * 0.8,
        2.4, (i + 1) * 0.25, 0.8, 'metal', 0, 'platform'),
    );
  }
  // Keep the stair entrance open and keep the side rails below eye height.
  brushes.push(
    box(`${id}-rail-w`, x - 2.8, z, 0.4, 0.8, 6, 'metal', height, 'coverLow'),
    box(`${id}-rail-e`, x + 2.8, z, 0.4, 0.8, 6, 'metal', height, 'coverLow'),
    box(`${id}-rail-n`, x, z - 2.8, 6, 0.8, 0.4, 'metal', height, 'coverLow'),
  );
  return brushes;
}

function outpostBrushes(): MapBrush[] {
  const brushes = perimeter(56, 8);
  for (const x of [-26, 26]) {
    for (const z of [-24, 24]) brushes.push(...bunker(`bunker-${x}-${z}`, x, z));
  }
  brushes.push(...lookout('watch-west', -43, 28, 4));
  brushes.push(...lookout('watch-east', 43, -28, 4));
  // An open central crossing, with waist-high firing positions around it.
  for (const x of [-12, 12]) {
    for (const z of [-12, 12]) {
      brushes.push(box(`sandbags-${x}-${z}`, x, z, 8, 1.1, 1.2, 'sandbag', 0, 'coverLow'));
    }
  }
  for (const x of [-8, 8]) {
    for (const z of [-32, 32]) {
      brushes.push(box(`supplies-${x}-${z}`, x, z, 3, 1.2, 3, 'crate', 0, 'coverLow'));
    }
  }
  for (const x of [-37, 37]) {
    brushes.push(box(`checkpoint-${x}`, x, 0, 1.2, 1.1, 9, 'sandbag', 0, 'coverLow'));
  }
  return brushes;
}

function streetBrushes(): MapBrush[] {
  const brushes = perimeter(64, 12);
  for (const x of [-30, 30]) {
    for (const [i, z] of [-42, -14, 14, 42].entries()) {
      // Buildings are solid masses, separated by ten-unit cross alleys.
      brushes.push(box(`block-${x}-${i}`, x, z, 20, 8 + (i % 3) * 2, 18, 'building'));
    }
    brushes.push(box(`pavement-${x}`, Math.sign(x) * 18.5, 0,
      3, 0.2, 112, 'concrete', 0, 'platform'));
  }
  for (const [i, z] of [-38, -10, 22, 46].entries()) {
    const x = i % 2 === 0 ? -9 : 9;
    brushes.push(
      box(`car-${i}-body`, x, z, 2.6, 1.1, 5.5, 'vehicle', 0, 'coverLow'),
      box(`car-${i}-cabin`, x, z, 2.2, 0.8, 2.6, 'vehicle', 1.1),
    );
  }
  // Climbable lookout decks in the rear alleys, accessible on ordinary steps.
  brushes.push(...lookout('alley-west', -50, 0, 3));
  brushes.push(...lookout('alley-east', 50, 0, 3));
  for (const x of [-13, 13]) {
    brushes.push(box(`barrier-${x}`, x, 6, 1.1, 1, 5, 'concrete', 0, 'coverLow'));
  }
  return brushes;
}

/** Legacy content is reused, not copied or regenerated, so old Container Yard replays do not change. */
export const ARENA_MAPS: readonly ArenaMap[] = [
  {
    id: 'container-yard', name: 'Container Yard', hash: 'container-yard-01',
    detail: '64 x 64. Stacked containers, a central corridor and six high-ground stacks.',
    halfSize: ARENA_HALF, wallHeight: WALL_HEIGHT, theme: 'yard',
    brushes: GREYBOX_BRUSHES, spawns: GREYBOX_SPAWNS, enemySpawns: GREYBOX_ENEMY_SPAWNS,
  },
  {
    id: 'military-outpost', name: 'Military Outpost', hash: 'military-outpost-01',
    detail: '112 x 112. Four walk-through bunkers, sandbag positions and two watchtowers.',
    halfSize: 56, wallHeight: 8, theme: 'outpost', brushes: outpostBrushes(),
    spawns: [
      { x: 0, z: -14, yaw: 0 }, { x: 0, z: 14, yaw: 0.5 },
      { x: -18, z: 0, yaw: 0.25 }, { x: 18, z: 0, yaw: 0.75 },
    ],
    enemySpawns: [
      { x: 0, z: 46 }, { x: 0, z: -46 }, { x: -16, z: 38 }, { x: 16, z: -38 },
      { x: -38, z: -16 }, { x: 38, z: 16 }, { x: -46, z: -46 }, { x: 46, z: 46 },
    ],
  },
  {
    id: 'urban-street', name: 'Urban Street', hash: 'urban-street-01',
    detail: '128 x 128. Eight city blocks, wide streets, cross alleys, cars and rear lookout decks.',
    halfSize: 64, wallHeight: 12, theme: 'urban', brushes: streetBrushes(),
    spawns: [
      { x: 0, z: -48, yaw: 0 }, { x: 0, z: 48, yaw: 0.5 },
      { x: -50, z: -28, yaw: 0.25 }, { x: 50, z: 28, yaw: 0.75 },
    ],
    enemySpawns: [
      { x: 0, z: 56 }, { x: 0, z: -56 }, { x: -14, z: 50 }, { x: 14, z: -50 },
      { x: -50, z: -28 }, { x: 50, z: 28 }, { x: -50, z: 48 }, { x: 50, z: -48 },
    ],
  },
];

export function getArenaMap(id: string): ArenaMap {
  const map = ARENA_MAPS.find((candidate) => candidate.id === id);
  if (!map) throw new Error(`Unknown arena: ${id}`);
  return map;
}

function fixed(n: number): number {
  return fx.fromRatio(Math.round(n * 1000), 1000);
}

function position(p: { x: number; z: number; y?: number }): Vec3Fx {
  return { x: fixed(p.x), y: fixed(p.y ?? 0), z: fixed(p.z) };
}

export function createArenaWorld(map: ArenaMap): CollisionWorld {
  if (map.id === 'container-yard') return createGreyboxWorld();
  const boxes = map.brushes.map((b) => boxFromCentre(
    fixed(b.x), fixed(b.y), fixed(b.z), fixed(b.width / 2), fixed(b.height / 2), fixed(b.depth / 2),
  ));
  return createCollisionWorld(boxes, {
    minX: fixed(-map.halfSize), minY: 0, minZ: fixed(-map.halfSize),
    maxX: fixed(map.halfSize), maxY: fixed(map.wallHeight * 4), maxZ: fixed(map.halfSize),
  });
}

export function createArenaContent(
  mapId: string,
  weapons: readonly [string, string] = ['rifle-01', 'pistol-01'],
): SimContent {
  const map = getArenaMap(mapId);
  const world = createArenaWorld(map);
  return {
    hash: map.hash, durationTicks: 10800, boxes: world.boxes, bounds: world.bounds,
    spawns: map.spawns.map(position), spawnYaw: fixed(map.spawns[0]!.yaw),
    enemySpawns: map.enemySpawns.map(position), maxHealth: fx.fromInt(100), weapons,
  };
}

/** Reject unknown content instead of replaying another arena under a client-supplied hash. */
export function resolveArenaContent(config: MatchConfig): SimContent {
  const map = getArenaMap(config.mapId);
  if (config.modeId !== 'survival') throw new Error('Unsupported arena mode');
  if (config.contentHash !== map.hash) throw new Error('Arena content hash mismatch');
  return createArenaContent(map.id, [config.loadout.primaryWeapon, config.loadout.secondaryWeapon]);
}
