import { describe, expect, it } from 'vitest';
import { Buttons, emptyInputFrame, type InputFrame } from '@rearena/protocol';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  restoreSimulation,
  serializeSimulation,
  step,
  summary,
  SIM_VERSION,
  type SimContent,
  type Simulation,
} from './kernel.js';
import { replay, replaySlice } from './replay.js';
import { deserializeState, serializeState } from './serialize.js';
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
 * The class of bug these exist for: a counter derived from events, kept outside SimState, survives a single-pass replay and
 * resets at a slice boundary. The browser scores the run one way, the verifier another, and an honest player is rejected.
 *
 * The headshot tally was exactly that. The suite already had slice-equivalence tests that did not catch it, because none of
 * them put a threshold across a boundary: every headshot happened to land in the same slice. That is the lesson these tests
 * encode, so the boundary here is placed deliberately rather than left to the slice size.
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

/*
 * Where injected enemies stand.
 *
 * Spawn 0 faces +Z from (0, -29). The south container row runs z -26 to -24 across x -9 to 9, which puts cover directly in that
 * sight line: an enemy injected 6 or 10 units ahead lands behind it and the AI correctly reports no line of sight. That is the
 * layout doing its job, not a defect, so these tests use the lane at x=+8 instead. The row ends at x=9, so +8 plus the enemy's
 * 0.4 half-width is just clear of it, and the corridor ahead is open to the arena centre.
 */
const LANE_X = 8;

/** Position the player in the clear lane. */
function placePlayer(sim: Simulation): void {
  sim.state.player.pos.x = fx.fromInt(LANE_X);
}

/** Position in the clear lane, at a given distance ahead of the player. */
function ahead(sim: Simulation, distance: number, id: number): EnemyState {
  const p = sim.state.player;
  return enemyAt(p.pos.x, p.pos.y, (p.pos.z + fx.fromInt(distance)) | 0, id);
}

/**
 * Keep exactly one one-shot-killable target at head height in front of the player, then step.
 *
 * Enemies are injected rather than waited for, because wave timing would put the fifth headshot wherever the schedule
 * happened to allow, and the whole point is to control which side of the boundary it falls on.
 *
 * Health is one unit so a single hit kills regardless of the damage table: a future rifle rebalance must not quietly turn
 * this into a four-headshot run and make the test pass for the wrong reason.
 */
function stepWithTarget(sim: Simulation, frame: InputFrame): void {
  if (sim.state.enemies.length === 0) {
    const enemy = ahead(sim, 6, sim.state.nextEntityId);
    enemy.health = fx.fromInt(1);
    sim.state.enemies = [enemy];
    sim.state.nextEntityId += 1;
  }
  step(sim, frame);
}

/** One firing tick followed by a gap, repeated, so each shot has a fresh target and a clear cooldown. */
function headshotFrames(count: number, gap: number): InputFrame[] {
  const frames: InputFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({ ...emptyInputFrame(frames.length), buttons: Buttons.Fire });
    for (let g = 0; g < gap; g++) frames.push(emptyInputFrame(frames.length));
  }
  return frames;
}

describe('headshot tally survives a slice boundary', () => {
  it('round trips through serialisation at every value', () => {
    // The narrow check: the field is in the byte layout at all.
    const sim = createSimulation(config(), content);
    for (const value of [0, 1, 4, 5, 99, 4294967295]) {
      sim.state.score.headshots = value;
      const restored = deserializeState(serializeState(sim.state, SIM_VERSION), SIM_VERSION);
      expect(restored.score.headshots).toBe(value);
    }
  });

  it('awards Marksman identically whether or not the run is resumed', () => {
    /*
     * The exact scenario from the review, and the assertion that fails on the old code.
     *
     * A single pass and a resumed pass are given the same inputs, with the resume point placed between the fourth and fifth
     * headshot. Previously the resumed simulation restored the tally as zero, counted the fifth headshot as its first, and
     * never awarded Marksman.
     */
    const cfg = config();
    const frames = headshotFrames(5, 20);

    // Single pass.
    const whole = createSimulation(cfg, content);
    placePlayer(whole);
    for (const frame of frames) stepWithTarget(whole, frame);

    // The scenario is only meaningful if five headshots actually happened and the medal was earned.
    expect(whole.state.score.headshots).toBeGreaterThanOrEqual(5);
    expect(whole.state.score.medalsMask & (1 << Medal.Marksman)).not.toBe(0);

    /*
     * Resumed pass. The boundary is the last firing tick, so four headshots are behind it and one ahead. Computed from the
     * frame layout rather than hardcoded, so changing the gap does not silently move the boundary to the wrong side.
     */
    const boundary = frames.length - 21;

    const first = createSimulation(cfg, content);
    placePlayer(first);
    for (let i = 0; i < boundary; i++) stepWithTarget(first, frames[i]!);

    const tallyAtBoundary = first.state.score.headshots;
    // Four, with the fifth still to come. If this ever fails the boundary has moved and the test proves nothing.
    expect(tallyAtBoundary).toBe(4);
    expect(first.state.score.medalsMask & (1 << Medal.Marksman)).toBe(0);

    const resumed = restoreSimulation(cfg, content, serializeSimulation(first));
    expect(resumed.state.score.headshots).toBe(tallyAtBoundary);

    for (let i = boundary; i < frames.length; i++) stepWithTarget(resumed, frames[i]!);

    // The medal must be present, and the whole score state must agree with the single pass.
    expect(resumed.state.score.medalsMask & (1 << Medal.Marksman)).not.toBe(0);
    expect(resumed.state.score.medalsMask).toBe(whole.state.score.medalsMask);
    expect(resumed.state.score.headshots).toBe(whole.state.score.headshots);
  });
});

describe('telegraph precedes damage', () => {
  it('does not damage the player on the tick it first sees them', () => {
    /*
     * The fairness rule the AI file claims. Before the fix, tryFire resolved the shot and set the telegraph afterwards, so a
     * heavy hit with no warning and the renderer's telegraph pose corresponded to a cooldown rather than a wind-up.
     */
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    placePlayer(sim);

    const enemy = ahead(sim, 10, 7);
    // Reaction delay already elapsed, so only the telegraph stands between sight and damage.
    enemy.reactionTicks = 0;
    sim.state.enemies = [enemy];

    const healthBefore = sim.state.player.health;
    const events = stepEnemies(sim.state, world);

    expect(events.some((e) => e.kind === 'telegraph')).toBe(true);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
    expect(sim.state.player.health).toBe(healthBefore);
    expect(sim.state.enemies[0]!.telegraphing).toBe(1);
  });

  it('abandons a wind-up when the player breaks line of sight', () => {
    /*
     * A telegraph the player cannot see is a shot with no warning, which defeats the mechanism. Losing sight must clear it
     * rather than letting the timer run down behind cover.
     */
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    placePlayer(sim);

    sim.state.enemies = [ahead(sim, 10, 8)];
    stepEnemies(sim.state, world);
    expect(sim.state.enemies[0]!.telegraphing).toBe(1);

    // Far outside sight range, which for this purpose is the same as stepping behind cover.
    sim.state.enemies[0]!.pos.z = (sim.state.player.pos.z + fx.fromInt(200)) | 0;
    stepEnemies(sim.state, world);
    expect(sim.state.enemies[0]!.telegraphing).toBe(0);
  });

  it('keeps the enemy still during a wind-up', () => {
    // A heavy that charges while winding up is precisely what the telegraph exists to prevent.
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    placePlayer(sim);

    sim.state.enemies = [ahead(sim, 30, 9)];

    stepEnemies(sim.state, world);
    expect(sim.state.enemies[0]!.telegraphing).toBe(1);

    const posBefore = { ...sim.state.enemies[0]!.pos };
    stepEnemies(sim.state, world);
    expect(sim.state.enemies[0]!.pos.x).toBe(posBefore.x);
    expect(sim.state.enemies[0]!.pos.z).toBe(posBefore.z);
  });

  it('eventually fires once the wind-up elapses', () => {
    // The other half of the rule: a telegraph that never resolves would make enemies harmless.
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    placePlayer(sim);

    sim.state.enemies = [ahead(sim, 10, 10)];

    let sawShot = false;
    for (let t = 0; t < 240 && !sawShot; t++) {
      const events = stepEnemies(sim.state, world);
      if (events.some((e) => e.kind === 'enemyShot')) sawShot = true;
      // decayTimers runs in step(), so the countdown has to be driven by hand here.
      for (const e of sim.state.enemies) {
        if (e.brainTicks > 0) e.brainTicks -= 1;
        if (e.reactionTicks > 0) e.reactionTicks -= 1;
        if (e.fireCooldownTicks > 0) e.fireCooldownTicks -= 1;
      }
    }

    expect(sawShot).toBe(true);
  });
});

describe('slice equivalence with combat', () => {
  it('matches a single pass across several slice sizes', () => {
    /*
     * Kept here as well as in replay.test.ts because this file's scenarios involve medals and telegraph state, which are the
     * values most likely to be left out of serialisation.
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

    // Coprime with the 60-tick checkpoint interval, so boundaries land at awkward offsets rather than tidy ones.
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
