/**
 * Replay: turn a recorded RunLog back into a round.
 *
 * Two entry points, one kernel:
 *
 * - replay() runs a whole log in one go. The client uses it for ghost playback and CI uses it
 *   for golden fixtures.
 * - replaySlice() runs a bounded number of ticks and hands back canonical state bytes so the
 *   next call can resume. The verify-run Edge Function uses it because the Supabase free plan
 *   caps CPU at 2 s per invocation, which is roughly the cost of one full 5 minute replay.
 *
 * Chained slices are equal to one full replay because the only thing carried between calls is
 * the canonical serialisation, and every resume asserts that the restored state hashes to the
 * value recorded before serialisation.
 */

import type {
  InputFrame,
  ReplayResult,
  RunLog,
  SliceResult,
  StateCheckpoint,
} from '@rearena/protocol';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  isEnded,
  restoreSimulation,
  serializeSimulation,
  step,
  summary,
  type SimContent,
  type Simulation,
} from './kernel.js';

export class ReplayError extends Error {}

export interface ReplayOptions {
  log: RunLog;
  content: SimContent;
  /** Stop at the first checkpoint that disagrees with the log. Default true. */
  stopOnMismatch?: boolean;
}

/** Index the log's checkpoints by tick so a hash can be compared the moment it is produced. */
function expectedByTick(log: RunLog): Map<number, string> {
  const m = new Map<number, string>();
  for (const c of log.checkpoints) m.set(c.tick, c.hash);
  return m;
}

function frameAt(frames: InputFrame[], index: number): InputFrame {
  const f = frames[index];
  if (!f) throw new ReplayError(`missing input frame at index ${index}`);
  return f;
}

/** Replay an entire log. */
export function replay(options: ReplayOptions): ReplayResult {
  const { log, content } = options;
  const stopOnMismatch = options.stopOnMismatch ?? true;
  const sim = createSimulation(log.matchConfig, content);
  const expected = expectedByTick(log);
  const checkpoints: StateCheckpoint[] = [];
  let mismatchTick: number | null = null;

  for (let i = 0; i < log.frames.length; i++) {
    step(sim, frameAt(log.frames, i));
    if (isCheckpointTick(sim)) {
      const hash = hashSimulation(sim);
      checkpoints.push({ tick: sim.state.tick, hash });
      const want = expected.get(sim.state.tick);
      if (want !== undefined && want !== hash && mismatchTick === null) {
        mismatchTick = sim.state.tick;
        if (stopOnMismatch) break;
      }
    }
    if (isEnded(sim)) break;
  }

  return { summary: summary(sim, log.summary.medals), checkpoints, mismatchTick };
}

export interface SliceOptions {
  log: RunLog;
  content: SimContent;
  /** Canonical state bytes from the previous slice. Omit to start at tick 0. */
  state?: Uint8Array | null;
  /** Tick the supplied state is positioned at. Must be 0 when state is omitted. */
  cursorTick: number;
  /** Upper bound on ticks replayed in this call. */
  maxTicks: number;
  /**
   * Hash of the state as it was when the previous slice serialised it. Checked after restore so a
   * serialisation defect surfaces immediately instead of as a false replay mismatch.
   */
  expectedResumeHash?: string;
}

/**
 * Replay at most maxTicks further ticks.
 *
 * Returns the bytes to resume from and done=false while ticks remain, or done=true with the
 * summary once the log is exhausted or the round ended. A hash mismatch ends the chain early:
 * there is no point spending the remaining slices.
 */
export function replaySlice(options: SliceOptions): SliceResult {
  const { log, content, cursorTick, maxTicks } = options;
  if (maxTicks <= 0) throw new ReplayError('maxTicks must be positive');
  if (cursorTick < 0 || cursorTick > log.frames.length) {
    throw new ReplayError(`cursorTick ${cursorTick} is outside the log`);
  }

  let sim: Simulation;
  if (options.state && cursorTick > 0) {
    sim = restoreSimulation(log.matchConfig, content, options.state);
    if (sim.state.tick !== cursorTick) {
      throw new ReplayError(
        `restored state is at tick ${sim.state.tick}, expected ${cursorTick}`,
      );
    }
    if (options.expectedResumeHash) {
      const actual = hashSimulation(sim);
      if (actual !== options.expectedResumeHash) {
        throw new ReplayError(
          `restored state hash ${actual} does not match ${options.expectedResumeHash}`,
        );
      }
    }
  } else {
    if (cursorTick !== 0) throw new ReplayError('cursorTick must be 0 without prior state');
    sim = createSimulation(log.matchConfig, content);
  }

  const expected = expectedByTick(log);
  const checkpoints: StateCheckpoint[] = [];
  let mismatchTick: number | null = null;
  let index = cursorTick;
  let replayed = 0;

  while (replayed < maxTicks && index < log.frames.length && !isEnded(sim)) {
    step(sim, frameAt(log.frames, index));
    index += 1;
    replayed += 1;
    if (isCheckpointTick(sim)) {
      const hash = hashSimulation(sim);
      checkpoints.push({ tick: sim.state.tick, hash });
      const want = expected.get(sim.state.tick);
      if (want !== undefined && want !== hash) {
        mismatchTick = sim.state.tick;
        break;
      }
    }
  }

  const exhausted = index >= log.frames.length || isEnded(sim);
  const done = exhausted || mismatchTick !== null;

  return {
    state: done ? null : serializeSimulation(sim),
    cursorTick: index,
    checkpoints,
    mismatchTick,
    summary: done && mismatchTick === null ? summary(sim, log.summary.medals) : null,
    done,
  };
}
