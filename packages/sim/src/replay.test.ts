import { describe, expect, it } from 'vitest';
import { emptyInputFrame, type InputFrame, type RunLog, type StateCheckpoint } from '@rearena/protocol';
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
import * as fx from './math/fixed.js';

/**
 * A stand-in for real content until WO-52 authors the first map. It only has to be stable: these
 * tests are about the replay machinery, not about gameplay values.
 */
const content: SimContent = {
  hash: 'testcontent0001',
  durationTicks: 1800, // 30 seconds
  spawn: { x: 0, y: 0, z: 0 },
  spawnYaw: 0,
  maxHealth: fx.fromInt(100),
  magazine: [30, 12],
  reserve: [120, 48],
};

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
 * Build a log by actually running the sim, so the checkpoints are the honest ones. A scripted
 * input pattern exercises look integration (the one system already wired into the kernel) and
 * varies per tick so a dropped or reordered frame would change the hash.
 */
function recordLog(ticks: number, seed = 777): RunLog {
  const cfg = config(seed);
  const sim = createSimulation(cfg, content);
  const frames: InputFrame[] = [];
  const checkpoints: StateCheckpoint[] = [];

  for (let t = 0; t < ticks; t++) {
    const frame: InputFrame = {
      ...emptyInputFrame(t),
      lookYaw: ((t * 37) % 211) - 105,
      lookPitch: ((t * 17) % 91) - 45,
      buttons: t % 9 === 0 ? 1 : 0,
    };
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

  it('produces a different hash for a different seed', () => {
    const a = recordLog(120, 1);
    const b = recordLog(120, 2);
    expect(a.summary.finalHash).not.toBe(b.summary.finalHash);
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
      step(sim, { ...emptyInputFrame(t), lookYaw: (t * 53) % 307 });
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
 * The property the chunked verifier depends on. If any of these fail, the Edge Function would
 * produce a different verdict than the browser and honest runs would be rejected.
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
    const slice = replaySlice({
      log: tampered,
      content,
      cursorTick: 0,
      maxTicks: 10000,
    });
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
    expect(() => replaySlice({ log, content, cursorTick: 0, maxTicks: 0 })).toThrow(
      /maxTicks/,
    );
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

  it('an edited input frame changes the checkpoint hashes', () => {
    const log = recordLog(180);
    const frames = log.frames.map((f, i) => (i === 50 ? { ...f, lookYaw: f.lookYaw + 1 } : f));
    const result = replay({ log: { ...log, frames }, content });
    expect(result.mismatchTick).not.toBeNull();
  });
});
