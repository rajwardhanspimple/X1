import { describe, expect, it } from 'vitest';
import {
  Buttons,
  emptyInputFrame,
  type InputFrame,
  type RunLog,
  type StateCheckpoint,
} from '@rearena/protocol';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  serializeSimulation,
  step,
  summary,
  SIM_VERSION,
  type SimContent,
} from './kernel.js';
import { deserializeState, serializeState } from './serialize.js';
import { replay, replaySlice } from './replay.js';
import { hash64 } from './hash/xxhash32.js';
import { createGreyboxWorld, greyboxEnemySpawns, greyboxPlayerSpawns } from './layout.js';
import * as fx from './math/fixed.js';

/**
 * The real greybox layout, so replay is tested against a player that collides, falls and jumps, and
 * against enemies that actually spawn. An idle player in an empty room would pass slice equivalence
 * trivially and prove nothing.
 */
function testContent(): SimContent {
  const world = createGreyboxWorld();
  return {
    hash: 'testcontent0003',
    durationTicks: 1800, // 30 seconds
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

function config(seed = 777) {
  return {
    mapId: 'test-arena',
    modeId: 'test-mode',
    seed,
    simVersion: SIM_VERSION,
    contentHash: content.hash,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

/**
 * A scripted input pattern that walks, strafes, sprints, jumps, shoots and reloads, so the log
 * exercises movement, collision, weapons and scoring. Every value is a pure function of the tick
 * index, so the script itself is reproducible.
 */
function scriptedFrame(t: number): InputFrame {
  const phase = Math.floor(t / 45) % 4;
  let moveX = 0;
  let moveY = 0;
  if (phase === 0) moveY = fx.FX_ONE;
  else if (phase === 1) moveX = fx.FX_ONE;
  else if (phase === 2) moveY = -fx.FX_ONE;
  else moveX = -fx.FX_ONE;

  let buttons = 0;
  if (t % 37 === 0) buttons |= Buttons.Jump;
  if (phase === 0) buttons |= Buttons.Sprint;
  if (t % 91 === 0) buttons |= Buttons.Crouch;
  // Fire in bursts, so the weapon system, spread bloom and recoil all move.
  if (t % 13 < 5) buttons |= Buttons.Fire;
  if (t % 200 === 150) buttons |= Buttons.Reload;
  if (t % 160 < 30) buttons |= Buttons.Aim;

  return {
    ...emptyInputFrame(t),
    moveX,
    moveY,
    lookYaw: ((t * 37) % 211) - 105,
    lookPitch: ((t * 17) % 91) - 45,
    buttons,
  };
}

/** Build a log by actually running the sim, so the checkpoints are the honest ones. */
function recordLog(ticks: number, seed = 777): RunLog {
  const cfg = config(seed);
  const sim = createSimulation(cfg, content);
  const frames: InputFrame[] = [];
  const checkpoints: StateCheckpoint[] = [];

  for (let t = 0; t < ticks; t++) {
    const frame = scriptedFrame(t);
    frames.push(frame);
    step(sim, frame);
    if (isCheckpointTick(sim)) {
      checkpoints.push({ tick: sim.state.tick, hash: hashSimulation(sim) });
    }
  }

  return {
    clientRunId: '00000000-0000-4000-8000-000000000001',
    matchConfig: cfg,
    clientVersion: 'test',
    frames,
    checkpoints,
    summary: summary(sim),
  };
}

describe('full replay', () => {
  it('reproduces the recorded summary and checkpoints', () => {
    const log = recordLog(300);
    const result = replay({ log, content });
    expect(result.mismatchTick).toBeNull();
    expect(result.summary.finalHash).toBe(log.summary.finalHash);
    expect(result.summary.score).toBe(log.summary.score);
    expect(result.summary.durationTicks).toBe(log.summary.durationTicks);
    expect(result.checkpoints).toEqual(log.checkpoints);
  });

  it('is stable across repeated runs of the same log', () => {
    const log = recordLog(240);
    const a = replay({ log, content });
    const b = replay({ log, content });
    expect(a.summary.finalHash).toBe(b.summary.finalHash);
    expect(a.checkpoints).toEqual(b.checkpoints);
  });

  it('moves the player away from the spawn point', () => {
    // Guards against the whole suite passing because nothing actually happens.
    const log = recordLog(180);
    const sim = createSimulation(log.matchConfig, content);
    for (const frame of log.frames) step(sim, frame);
    const spawn = content.spawns[0]!;
    const moved =
      Math.abs(sim.state.player.pos.x - spawn.x) + Math.abs(sim.state.player.pos.z - spawn.z);
    expect(moved).toBeGreaterThan(fx.FX_ONE);
  });

  it('fires shots during the recorded log', () => {
    // Another guard: a log that never pulls the trigger would not test combat determinism.
    const log = recordLog(180);
    expect(log.summary.shotsFired).toBeGreaterThan(0);
  });

  it('spawns enemies during the recorded log', () => {
    // Waves begin at tick 180, so a 300-tick log must have seen at least one.
    const sim = createSimulation(config(), content);
    for (let t = 0; t < 300; t++) step(sim, scriptedFrame(t));
    expect(sim.state.waveCursor).toBeGreaterThan(0);
  });

  it('reports the tick of a tampered checkpoint', () => {
    const log = recordLog(300);
    const target = log.checkpoints[2];
    expect(target).toBeDefined();
    const tampered: RunLog = {
      ...log,
      checkpoints: log.checkpoints.map((c) =>
        c.tick === target!.tick ? { ...c, hash: 'deadbeefdeadbeef' } : c,
      ),
    };
    const result = replay({ log: tampered, content });
    expect(result.mismatchTick).toBe(target!.tick);
  });

  it('rejects a log whose simVersion is not this build', () => {
    const log = recordLog(60);
    const wrong: RunLog = {
      ...log,
      matchConfig: { ...log.matchConfig, simVersion: SIM_VERSION + 1 },
    };
    expect(() => replay({ log: wrong, content })).toThrow(/simVersion/);
  });

  it('rejects a log whose contentHash does not match the content', () => {
    const log = recordLog(60);
    const wrong: RunLog = {
      ...log,
      matchConfig: { ...log.matchConfig, contentHash: 'someothercontent' },
    };
    expect(() => replay({ log: wrong, content })).toThrow(/contentHash/);
  });

  it('recomputes medals rather than trusting the log', () => {
    /*
     * A log claiming medals it never earned must not have them echoed back. The replayed summary is
     * derived entirely from replayed state, so the claim is simply ignored.
     */
    const log = recordLog(300);
    const lying: RunLog = {
      ...log,
      summary: { ...log.summary, medals: ['Untouchable', 'Marksman', 'Survivor'] },
    };
    const result = replay({ log: lying, content });
    expect(result.summary.medals).toEqual(log.summary.medals);
  });
});

describe('one frame per tick', () => {
  it('throws when a frame does not match the current tick', () => {
    const sim = createSimulation(config(), content);
    expect(() => step(sim, emptyInputFrame(5))).toThrow(/does not match sim tick/);
  });
});

describe('state serialisation', () => {
  it('round trips to an identical hash at many ticks', () => {
    const sim = createSimulation(config(), content);
    for (let t = 0; t < 400; t++) {
      step(sim, scriptedFrame(t));
      if (t % 37 === 0) {
        const before = hashSimulation(sim);
        const bytes = serializeSimulation(sim);
        const restored = deserializeState(bytes, SIM_VERSION);
        expect(hash64(serializeState(restored, SIM_VERSION))).toBe(before);
      }
    }
  });

  it('rejects bytes written by another sim version', () => {
    const sim = createSimulation(config(), content);
    const bytes = serializeSimulation(sim);
    expect(() => deserializeState(bytes, SIM_VERSION + 1)).toThrow(/simVersion/);
  });

  it('rejects a buffer that is not a SimState', () => {
    const junk = new Uint8Array(64);
    expect(() => deserializeState(junk, SIM_VERSION)).toThrow(/not a SimState/);
  });
});

/**
 * The property the chunked verifier depends on. If any of these fail, the Edge Function would produce
 * a different verdict than the browser and honest runs would be rejected.
 */
describe('slice replay equals full replay', () => {
  const log = recordLog(600);
  const full = replay({ log, content });

  for (const sliceSize of [1, 3, 7, 61, 500]) {
    it(`matches when replayed ${sliceSize} ticks at a time`, () => {
      let state: Uint8Array | null = null;
      let cursor = 0;
      let guard = 0;
      const checkpoints: StateCheckpoint[] = [];
      let finalSummary = null as ReturnType<typeof summary> | null;

      while (guard < 10000) {
        guard += 1;
        const slice = replaySlice({
          log,
          content,
          state,
          cursorTick: cursor,
          maxTicks: sliceSize,
        });
        checkpoints.push(...slice.checkpoints);
        expect(slice.mismatchTick).toBeNull();
        cursor = slice.cursorTick;
        state = slice.state;
        if (slice.done) {
          finalSummary = slice.summary;
          break;
        }
      }

      expect(cursor).toBe(log.frames.length);
      expect(finalSummary).not.toBeNull();
      expect(finalSummary!.finalHash).toBe(full.summary.finalHash);
      expect(finalSummary!.score).toBe(full.summary.score);
      expect(finalSummary!.durationTicks).toBe(full.summary.durationTicks);
      expect(finalSummary!.medals).toEqual(full.summary.medals);
      expect(checkpoints).toEqual(full.checkpoints);
    });
  }

  it('carries no state on the final slice', () => {
    const slice = replaySlice({ log, content, cursorTick: 0, maxTicks: 10000 });
    expect(slice.done).toBe(true);
    expect(slice.state).toBeNull();
    expect(slice.summary).not.toBeNull();
  });

  it('stops the chain at the first mismatching checkpoint', () => {
    const target = log.checkpoints[1];
    expect(target).toBeDefined();
    const tampered: RunLog = {
      ...log,
      checkpoints: log.checkpoints.map((c) =>
        c.tick === target!.tick ? { ...c, hash: '0000000000000000' } : c,
      ),
    };
    const slice = replaySlice({ log: tampered, content, cursorTick: 0, maxTicks: 10000 });
    expect(slice.mismatchTick).toBe(target!.tick);
    expect(slice.done).toBe(true);
    expect(slice.summary).toBeNull();
  });

  it('refuses to resume at the wrong tick', () => {
    const first = replaySlice({ log, content, cursorTick: 0, maxTicks: 30 });
    expect(first.done).toBe(false);
    expect(() =>
      replaySlice({
        log,
        content,
        state: first.state,
        cursorTick: first.cursorTick + 1,
        maxTicks: 30,
      }),
    ).toThrow(/expected/);
  });

  it('refuses to resume when the expected hash does not match', () => {
    const first = replaySlice({ log, content, cursorTick: 0, maxTicks: 30 });
    expect(() =>
      replaySlice({
        log,
        content,
        state: first.state,
        cursorTick: first.cursorTick,
        maxTicks: 30,
        expectedResumeHash: 'ffffffffffffffff',
      }),
    ).toThrow(/does not match/);
  });

  it('requires a zero cursor when starting fresh', () => {
    expect(() => replaySlice({ log, content, cursorTick: 10, maxTicks: 10 })).toThrow(
      /cursorTick must be 0/,
    );
  });

  it('requires a positive slice size', () => {
    expect(() => replaySlice({ log, content, cursorTick: 0, maxTicks: 0 })).toThrow(/maxTicks/);
  });
});

describe('tamper detection', () => {
  it('a claimed score higher than the replay is visible to the caller', () => {
    const log = recordLog(180);
    const cheated: RunLog = {
      ...log,
      summary: { ...log.summary, score: log.summary.score + 50000 },
    };
    const result = replay({ log: cheated, content });
    // Checkpoints still agree, because only the claim was edited, not the inputs.
    expect(result.mismatchTick).toBeNull();
    // The verifier compares claimed against replayed and rejects on this difference.
    expect(result.summary.score).not.toBe(cheated.summary.score);
  });

  it('an edited look input changes the checkpoint hashes', () => {
    const log = recordLog(180);
    const frames = log.frames.map((f, i) => (i === 50 ? { ...f, lookYaw: f.lookYaw + 1 } : f));
    const result = replay({ log: { ...log, frames }, content });
    expect(result.mismatchTick).not.toBeNull();
  });

  it('an edited movement input changes the checkpoint hashes', () => {
    const log = recordLog(180);
    const frames = log.frames.map((f, i) => (i === 70 ? { ...f, moveX: fx.FX_ONE } : f));
    const result = replay({ log: { ...log, frames }, content });
    expect(result.mismatchTick).not.toBeNull();
  });

  it('an edited fire input changes the checkpoint hashes', () => {
    const log = recordLog(180);
    const frames = log.frames.map((f, i) =>
      i === 90 ? { ...f, buttons: f.buttons | Buttons.Fire } : f,
    );
    const result = replay({ log: { ...log, frames }, content });
    expect(result.mismatchTick).not.toBeNull();
  });
});
