import { describe, expect, it } from 'vitest';
import { Buttons, emptyInputFrame, type MatchConfig, type RunLog } from '@rearena/protocol';
import {
  ARENA_MAPS,
  createArenaContent,
  createArenaWorld,
  getArenaMap,
  resolveArenaContent,
} from './maps.js';
import { createGreyboxWorld, greyboxEnemySpawns, greyboxPlayerSpawns } from './layout.js';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  step,
  summary,
  SIM_VERSION,
} from './kernel.js';
import { replay, replaySlice } from './replay.js';
import { bodyShape, stepPlayerMovement } from './movement.js';
import { raycast } from './collision.js';
import * as fx from './math/fixed.js';

type SolidBox = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

function config(mapId: string): MatchConfig {
  return {
    mapId,
    modeId: 'survival',
    contentHash: getArenaMap(mapId).hash,
    simVersion: SIM_VERSION,
    seed: 77191,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

function fixed(n: number): number {
  return fx.fromRatio(Math.round(n * 1000), 1000);
}

function overlapsSolid(
  pos: { x: number; y: number; z: number },
  shape: ReturnType<typeof bodyShape>,
  boxes: readonly SolidBox[],
): boolean {
  return boxes.some(
    (b) =>
      pos.x - shape.halfWidth < b.maxX &&
      pos.x + shape.halfWidth > b.minX &&
      pos.z - shape.halfWidth < b.maxZ &&
      pos.z + shape.halfWidth > b.minZ &&
      pos.y < b.maxY &&
      pos.y + shape.height > b.minY,
  );
}

function insideFootprint(
  pos: { x: number; z: number },
  brush: { x: number; z: number; width: number; depth: number },
): boolean {
  return (
    pos.x >= fixed(brush.x - brush.width / 2) &&
    pos.x <= fixed(brush.x + brush.width / 2) &&
    pos.z >= fixed(brush.z - brush.depth / 2) &&
    pos.z <= fixed(brush.z + brush.depth / 2)
  );
}

function record(mapId: string): RunLog {
  const matchConfig = config(mapId);
  const sim = createSimulation(matchConfig, createArenaContent(mapId));
  const frames = Array.from({ length: 10800 }, (_, tick) => ({
    ...emptyInputFrame(tick),
    lookYaw: tick % 20 === 0 ? fx.fromRatio(1, 100) : 0,
    moveY: tick % 240 < 60 ? fx.FX_ONE : 0,
    buttons: tick % 300 > 240 ? Buttons.Reload : Buttons.Fire,
  }));
  const checkpoints = [];
  for (const frame of frames) {
    step(sim, frame);
    if (isCheckpointTick(sim)) {
      checkpoints.push({ tick: sim.state.tick, hash: hashSimulation(sim) });
    }
    if (sim.state.ended === 1) break;
  }
  return {
    clientRunId: `map-test-${mapId}`,
    clientVersion: 'test',
    matchConfig,
    frames,
    checkpoints,
    summary: summary(sim),
  };
}

describe('built-in arenas', () => {
  it('retains the complete legacy world and spawn data', () => {
    const content = createArenaContent('container-yard');
    expect(content.boxes).toEqual(createGreyboxWorld().boxes);
    expect(content.bounds).toEqual(createGreyboxWorld().bounds);
    expect(content.spawns).toEqual(greyboxPlayerSpawns());
    expect(content.enemySpawns).toEqual(greyboxEnemySpawns());
    expect(content.hash).toBe('container-yard-01');
    expect(content.spawnYaw).toBe(0);
    expect(content.durationTicks).toBe(10800);
  });

  it('has three distinct identities and larger new maps', () => {
    expect(new Set(ARENA_MAPS.map((m) => m.id)).size).toBe(3);
    expect(new Set(ARENA_MAPS.map((m) => m.hash)).size).toBe(3);
    expect(getArenaMap('military-outpost').halfSize * 2).toBe(112);
    expect(getArenaMap('urban-street').halfSize * 2).toBe(128);
  });

  it('map brushes have unique names and finite positive dimensions', () => {
    for (const map of ARENA_MAPS) {
      expect(
        new Set(map.brushes.map((brush) => brush.name)).size,
        `${map.id}: duplicate brush name`,
      ).toBe(map.brushes.length);
      for (const brush of map.brushes) {
        expect(
          Number.isFinite(brush.x) &&
            Number.isFinite(brush.y) &&
            Number.isFinite(brush.z) &&
            Number.isFinite(brush.width) &&
            Number.isFinite(brush.height) &&
            Number.isFinite(brush.depth),
          `${map.id}: ${brush.name} has non-finite geometry`,
        ).toBe(true);
        expect(brush.width, `${map.id}: ${brush.name} width must be positive`).toBeGreaterThan(0);
        expect(brush.height, `${map.id}: ${brush.name} height must be positive`).toBeGreaterThan(0);
        expect(brush.depth, `${map.id}: ${brush.name} depth must be positive`).toBeGreaterThan(0);
      }
    }
  });

  it('rejects an unknown map, wrong revision or wrong mode', () => {
    expect(() => getArenaMap('missing')).toThrow('Unknown arena');
    expect(() =>
      resolveArenaContent({ ...config('urban-street'), contentHash: 'container-yard-01' }),
    ).toThrow();
    expect(() => resolveArenaContent({ ...config('urban-street'), modeId: 'missing' })).toThrow();
  });

  for (const map of ARENA_MAPS) {
    it(`${map.name}: all spawn bodies are clear and within bounds`, () => {
      const content = createArenaContent(map.id);
      const shape = bodyShape(false);
      for (const spawn of [...content.spawns, ...content.enemySpawns]) {
        expect(spawn.x - shape.halfWidth).toBeGreaterThan(content.bounds.minX);
        expect(spawn.x + shape.halfWidth).toBeLessThan(content.bounds.maxX);
        expect(spawn.z - shape.halfWidth).toBeGreaterThan(content.bounds.minZ);
        expect(spawn.z + shape.halfWidth).toBeLessThan(content.bounds.maxZ);
        expect(
          overlapsSolid(spawn, shape, content.boxes),
          `${map.id}: spawn intersects solid`,
        ).toBe(false);
      }
    });

    it(`${map.name}: initial view faces at least 12 units of clear ground`, () => {
      const content = createArenaContent(map.id);
      const p = content.spawns[0]!;
      const eye = { ...p, y: p.y + fx.fromRatio(165, 100) };
      const direction = {
        x: fx.sinTurns(content.spawnYaw),
        y: 0,
        z: fx.cosTurns(content.spawnYaw),
      };
      const hit = raycast(createArenaWorld(map), eye, direction, fx.fromInt(12));
      expect(hit).toBeNull();
    });

    it(`${map.name}: full replay and two-slice replay agree`, () => {
      const log = record(map.id);
      const content = resolveArenaContent(log.matchConfig);
      const full = replay({ log, content });
      const first = replaySlice({ log, content, cursorTick: 0, maxTicks: 6000 });
      expect(full.mismatchTick).toBeNull();
      expect(first.done).toBe(false);
      expect(first.cursorTick).toBe(6000);
      expect(first.mismatchTick).toBeNull();
      const second = replaySlice({
        log,
        content,
        state: first.state,
        cursorTick: first.cursorTick,
        maxTicks: 6000,
      });
      expect(second.done).toBe(true);
      expect(second.mismatchTick).toBeNull();
      expect(second.summary).toEqual(full.summary);
      expect(full.summary).toEqual(log.summary);
    }, 30000);
  }

  for (const map of ARENA_MAPS.filter((m) => m.theme !== 'yard')) {
    it(`${map.name}: lookout stairs reach each deck without overlap`, () => {
      const content = createArenaContent(map.id);
      const world = createArenaWorld(map);
      const standShape = bodyShape(false);
      const starts = map.brushes.filter((brush) => brush.name.endsWith('-step-0'));
      expect(starts.length, `${map.id}: missing lookout stairs`).toBeGreaterThan(0);

      for (const first of starts) {
        const prefix = first.name.slice(0, -'-step-0'.length);
        const deck = map.brushes.find((brush) => brush.name === `${prefix}-deck`);
        expect(deck, `${map.id}: missing deck for ${prefix}`).toBeTruthy();
        const deckBrush = deck!;
        const deckTop = fixed(deckBrush.y + deckBrush.height / 2);
        const sim = createSimulation(config(map.id), content);
        const p = sim.state.player;
        p.pos = {
          x: fixed(first.x),
          y: 0,
          z: fixed(first.z + 1.4),
        };
        p.yaw = fx.FX_HALF;

        let reachedDeck = false;
        let maxY = p.pos.y;
        for (let t = 0; t < 240; t++) {
          stepPlayerMovement(p, { ...emptyInputFrame(t), moveY: fx.FX_ONE }, world);
          if (p.pos.y > maxY) maxY = p.pos.y;
          if (insideFootprint(p.pos, deckBrush) && p.pos.y === deckTop) {
            expect(
              overlapsSolid(p.pos, standShape, content.boxes),
              `${map.id}: ${prefix} overlaps solid`,
            ).toBe(false);
            reachedDeck = true;
            break;
          }
        }

        expect(reachedDeck, `${map.id}: ${prefix} never reached deck`).toBe(true);
        expect(maxY, `${map.id}: ${prefix} climbed above deck top`).toBe(deckTop);
      }
    });
  }
});
