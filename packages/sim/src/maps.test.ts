import { describe, expect, it } from 'vitest';
import { Buttons, emptyInputFrame, type MatchConfig, type RunLog } from '@rearena/protocol';
import { ARENA_MAPS, createArenaContent, createArenaWorld, getArenaMap, resolveArenaContent } from './maps.js';
import { createGreyboxWorld, greyboxPlayerSpawns, greyboxEnemySpawns } from './layout.js';
import { createSimulation, step, summary, SIM_VERSION } from './kernel.js';
import { replay, replaySlice } from './replay.js';
import { bodyShape, stepPlayerMovement } from './movement.js';
import { raycast } from './collision.js';
import * as fx from './math/fixed.js';

function config(mapId: string): MatchConfig {
  return {
    mapId, modeId: 'survival', contentHash: getArenaMap(mapId).hash, simVersion: SIM_VERSION,
    seed: 77191, loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
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
  for (const frame of frames) step(sim, frame);
  return { clientRunId: `map-test-${mapId}`, clientVersion: 'test', matchConfig,
    frames, checkpoints: [], summary: summary(sim) };
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

  it('rejects an unknown map, wrong revision or wrong mode', () => {
    expect(() => getArenaMap('missing')).toThrow('Unknown arena');
    expect(() => resolveArenaContent({ ...config('urban-street'), contentHash: 'container-yard-01' })).toThrow();
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
        for (const b of content.boxes) {
          const overlaps = spawn.x - shape.halfWidth < b.maxX && spawn.x + shape.halfWidth > b.minX &&
            spawn.z - shape.halfWidth < b.maxZ && spawn.z + shape.halfWidth > b.minZ &&
            spawn.y < b.maxY && spawn.y + shape.height > b.minY;
          expect(overlaps, `${map.id}: spawn intersects solid`).toBe(false);
        }
      }
    });

    it(`${map.name}: initial view faces at least 12 units of clear ground`, () => {
      const content = createArenaContent(map.id);
      const p = content.spawns[0]!;
      const eye = { ...p, y: p.y + fx.fromRatio(165, 100) };
      const direction = { x: fx.sinTurns(content.spawnYaw), y: 0, z: fx.cosTurns(content.spawnYaw) };
      const hit = raycast(createArenaWorld(map), eye, direction, fx.fromInt(12));
      expect(hit).toBeNull();
    });

    it(`${map.name}: full replay and two-slice replay agree`, () => {
      const log = record(map.id);
      const content = resolveArenaContent(log.matchConfig);
      const full = replay({ log, content });
      const first = replaySlice({ log, content, cursorTick: 0, maxTicks: 6000 });
      expect(first.done).toBe(false);
      expect(first.cursorTick).toBe(6000);
      const second = replaySlice({ log, content, state: first.state, cursorTick: first.cursorTick, maxTicks: 6000 });
      expect(second.done).toBe(true);
      expect(second.mismatchTick).toBeNull();
      expect(second.summary).toEqual(full.summary);
      expect(full.summary).toEqual(log.summary);
    }, 30000);
  }

  for (const map of ARENA_MAPS.filter((m) => m.theme !== 'yard')) {
    it(`${map.name}: lookout stairs can be climbed without jumping`, () => {
      const world = createArenaWorld(map);
      const first = map.brushes.find((b) => b.name.endsWith('-step-0'))!;
      const sim = createSimulation(config(map.id), createArenaContent(map.id));
      const p = sim.state.player;
      p.pos = { x: fx.fromRatio(Math.round(first.x * 100), 100), y: 0,
        z: fx.fromRatio(Math.round((first.z + 1.4) * 100), 100) };
      p.yaw = fx.FX_HALF;
      for (let t = 0; t < 155; t++) {
        stepPlayerMovement(p, { ...emptyInputFrame(t), moveY: fx.FX_ONE }, world);
      }
      expect(fx.toFloat(p.pos.y)).toBeGreaterThanOrEqual(map.theme === 'outpost' ? 3.95 : 2.95);
    });
  }
});
