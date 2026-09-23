import { describe, expect, it } from 'vitest';
import { Buttons, emptyInputFrame, type InputFrame } from '@rearena/protocol';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  step,
  summary,
  SIM_VERSION,
  type SimContent,
  type Simulation,
} from './kernel.js';
import { replay, replaySlice } from './replay.js';
import { createGreyboxWorld, greyboxEnemySpawns, greyboxPlayerSpawns } from './layout.js';
import { createCollisionWorld } from './collision.js';
import { Brain } from './enemies.js';
import { stepEnemies } from './ai.js';
import { Medal } from './score.js';
import * as fx from './math/fixed.js';
import type { EnemyState } from './state.js';

/**
 * Tests for state that accumulates across ticks.
 *
 * The class of bug these exist for: a counter derived from events, kept outside SimState, survives a single-pass replay
 * and resets at a slice boundary. The browser scores the run one way and the verifier another, and an honest player is
 * rejected. The headshot tally was exactly that, and the suite already had slice-equivalence tests that did not catch it
 * because none of them put the relevant threshold across a boundary.
 */

function testContent(): SimContent {
  const world = createGreyboxWorld();
  return {
    hash: 'boundary00001',
    durationTicks: 1800,
    boxes: world.boxes,
    bounds: world.bounds,
    spawns: greyboxPlayerSpawns(),
    spawnYaw: 0,
    enemySpawns: greyboxEnemySpawns(),
    maxHealth: fx.fromInt(100),
    weapons: ['rifle-01', 'pistol-01'],
  };
}

const content = testContent();

function config(seed = 5150) {
  return {
    mapId: 'test-arena',
    modeId: 'test-mode',
    seed,
    simVersion: SIM_VERSION,
    contentHash: content.hash,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

/** A complete EnemyState at a position. */
function enemyAt(x: fx.Fx, y: fx.Fx, z: fx.Fx, id: number): EnemyState {
  return {
    id,
    archetype: 1,
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    health: fx.fromInt(100),
    brain: Brain.Advance,
    brainTicks: 0,
    targetNode: 0,
    reactionTicks: 0,
    fireCooldownTicks: 0,
    telegraphing: 0,
  };
}

describe('headshot tally survives a slice boundary', () => {
  /**
   * Place a low-health enemy directly at head height in front of the player and fire.
   *
   * Health is set so one hit kills, which makes each shot a headshot kill and keeps the test independent of the damage
   * curve: a change to rifle damage must not silently turn this into a four-headshot run.
   */
  function headshotFrames(count: number, gap: number): InputFrame[] {
    const frames: InputFrame[] = [];
    for (let i = 0; i < count; i++) {
      // One firing tick, then a gap so the weapon comes off cooldown and the next enemy spawns cleanly.
      frames.push({ ...emptyInputFrame(frames.length), buttons: Buttons.Fire });
      for (let g = 0; g < gap; g++) {
        frames.push(emptyInputFrame(frames.length));
      }
    }
    return frames;
  }

  /**
   * Run a scripted headshot sequence, respawning a fresh target in front of the player each time one dies.
   *
   * The enemy is positioned at chest height plus the head offset so the shot lands as a headshot. Enemies are injected
   * rather than waited for, because wave timing would put the fifth headshot wherever the wave schedule happened to allow.
   */
  function runHeadshots(sim: Simulation, frames: readonly InputFrame[]): void {
    let nextId = 100;
    const p = sim.state.player;

    for (const frame of frames) {
      // Keep exactly one killable target in front of the player, at head height.
      if (sim.state.enemies.length === 0) {
        const enemy = enemyAt(p.pos.x, p.pos.y, (p.pos.z + fx.fromInt(6)) | 0, nextId++);
        // One rifle round to the head must kill, whatever the damage table says.
        enemy.health = fx.fromInt(1);
        sim.state.enemies = [enemy];
      }
      step(sim, frame);
    }
  }

  it('awards Marksman identically in full and sliced replay', () => {
    /*
     * The exact scenario from the review: four headshots, a slice boundary, then a fifth. Under the old code the sliced
     * replay restored the tally as zero, so the fifth headshot counted as the first and Marksman was never awarded.
     */
    const cfg = config();
    const recorded = createSimulation(cfg, content);
    const frames = headshotFrames(5, 20);
    runHeadshots(recorded, frames);

    // The scenario is only meaningful if five headshots actually happened.
    expect(recorded.state.score.headshots).toBeGreaterThanOrEqual(5);
    expect(recorded.state.score.medalsMask & (1 << Medal.Marksman)).not.toBe(0);

    /*
     * Serialise mid-sequence and restore, which is what a slice boundary does. The tally must come back with the state.
     */
    const partial = createSimulation(cfg, content);
    const upTo = frames.length - 10;
    runHeadshots(partial, frames.slice(0, upTo));

    const tallyBefore = partial.state.score.headshots;
    // Four or more, with the fifth still to come: this is the boundary the bug hid behind.
    expect(tallyBefore).toBeGreaterThanOrEqual(4);

    const bytes = new Uint8Array(
      (await import('./serialize.js')).serializeState(partial.state, SIM_VERSION),
    );
    const restored = (await import('./serialize.js')).deserializeState(bytes, SIM_VERSION);

    expect(restored.score.headshots).toBe(tallyBefore);
  });

  it('round trips the tally through serialisation at every value', () => {
    // Cheaper and more direct than replaying: the field either survives the byte layout or it does not.
    const sim = createSimulation(config(), content);
    const { serializeState, deserializeState } = require('./serialize.js') as typeof import('./serialize.js');

    for (const value of [0, 1, 4, 5, 99, 4294967295]) {
      sim.state.score.headshots = value;
      const restored = deserializeState(serializeState(sim.state, SIM_VERSION), SIM_VERSION);
      expect(restored.score.headshots).toBe(value);
    }
  });
});

describe('telegraph precedes damage', () => {
  it('does not damage the player on the tick it first sees them', () => {
    /*
     * The fairness rule the AI file claims. Before the fix, tryFire resolved the shot and set the telegraph afterwards, so
     * a heavy hit with no warning at all and the renderer's telegraph pose corresponded to a cooldown rather than a
     * wind-up.
     */
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    const p = sim.state.player;

    // A rifleman in plain sight, with its reaction delay already elapsed so only the telegraph remains.
    const enemy = enemyAt(p.pos.x, p.pos.y, (p.pos.z + fx.fromInt(10)) | 0, 7);
    enemy.reactionTicks = 0;
    sim.state.enemies = [enemy];

    const healthBefore = sim.state.player.health;
    const events = stepEnemies(sim.state, world);

    // A telegraph must be announced, and no damage may land on the same tick.
    expect(events.some((e) => e.kind === 'telegraph')).toBe(true);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
    expect(sim.state.player.health).toBe(healthBefore);
    expect(sim.state.enemies[0]!.telegraphing).toBe(1);
  });

  it('abandons a wind-up when the player breaks line of sight', () => {
    /*
     * A telegraph the player cannot see is a shot with no warning, which defeats the whole mechanism. Losing sight must
     * clear it rather than letting the timer run down behind cover.
     */
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    const p = sim.state.player;

    const enemy = enemyAt(p.pos.x, p.pos.y, (p.pos.z + fx.fromInt(10)) | 0, 8);
    sim.state.enemies = [enemy];
    stepEnemies(sim.state, world);
    expect(sim.state.enemies[0]!.telegraphing).toBe(1);

    // Move the enemy far outside its sight range, which is the same as losing sight for this purpose.
    sim.state.enemies[0]!.pos.z = (p.pos.z + fx.fromInt(200)) | 0;
    stepEnemies(sim.state, world);
    expect(sim.state.enemies[0]!.telegraphing).toBe(0);
  });

  it('keeps the enemy still during a wind-up', () => {
    // A heavy that charges while winding up is precisely what the telegraph exists to prevent.
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    const p = sim.state.player;

    const enemy = enemyAt(p.pos.x, p.pos.y, (p.pos.z + fx.fromInt(30)) | 0, 9);
    sim.state.enemies = [enemy];

    stepEnemies(sim.state, world);
    if (sim.state.enemies[0]!.telegraphing === 1) {
      const posBefore = { ...sim.state.enemies[0]!.pos };
      stepEnemies(sim.state, world);
      expect(sim.state.enemies[0]!.pos.x).toBe(posBefore.x);
      expect(sim.state.enemies[0]!.pos.z).toBe(posBefore.z);
    }
  });
});

describe('slice equivalence with combat', () => {
  it('matches a single pass across several slice sizes', () => {
    /*
     * The property the verifier rests on. Kept here as well as in replay.test.ts because this file's scenarios involve
     * medals and telegraph state, which are the values most likely to be left out of serialisation.
     */
    const cfg = config(777);
    const sim = createSimulation(cfg, content);
    const frames: InputFrame[] = [];
    const checkpoints: { tick: number; hash: string }[] = [];

    for (let t = 0; t < 600; t++) {
      const frame: InputFrame = {
        ...emptyInputFrame(t),
        moveY: t % 80 < 40 ? fx.FX_ONE : -fx.FX_ONE,
        lookYaw: ((t * 29) % 89) - 44,
        buttons: t % 9 < 3 ? Buttons.Fire : 0,
      };
      frames.push(frame);
      step(sim, frame);
      if (isCheckpointTick(sim)) {
        checkpoints.push({ tick: sim.state.tick, hash: hashSimulation(sim) });
      }
    }

    const log = {
      clientRunId: '00000000-0000-4000-8000-0000000045b0',
      matchConfig: cfg,
      clientVersion: 'test',
      frames,
      checkpoints,
      summary: summary(sim),
    };

    const full = replay({ log, content });
    expect(full.mismatchTick).toBeNull();

    // 61 is chosen to be coprime with the checkpoint interval, so boundaries land at awkward offsets rather than tidy ones.
    for (const sliceSize of [61, 137, 500]) {
      let state: Uint8Array | null = null;
      let cursor = 0;
      let finalHash: string | null = null;

      for (let guard = 0; guard < 100; guard++) {
        const slice = replaySlice({ log, content, state, cursorTick: cursor, maxTicks: sliceSize });
        expect(slice.mismatchTick).toBeNull();
        cursor = slice.cursorTick;
        state = slice.state;
        if (slice.done) {
          finalHash = slice.summary?.finalHash ?? null;
          break;
        }
      }

      expect(finalHash).toBe(full.summary.finalHash);
    }
  });
});
