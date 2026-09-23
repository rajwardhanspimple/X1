/**
 * Replay: re-run a recorded log and compare the result.
 *
 * This is what makes a score verifiable. The server holds no gameplay state of its own; it replays the
 * player's inputs through the identical simulation and checks that the state hashes it computes match
 * the ones the client recorded.
 *
 * Two functions, one property:
 *
 * `replay` runs a whole log in one call. Used by tests and by any environment without a CPU limit.
 *
 * `replaySlice` runs a bounded number of ticks and returns serialised state to resume from. Used by
 * the verify-run Edge Function, which has a CPU budget far below the cost of a three-minute replay and
 * so must spread the work across invocations.
 *
 * The property the slice tests enforce: replaying a log in slices of any size produces byte-identical
 * state, the same checkpoints and the same summary as replaying it in one pass. Without that, chunked
 * verification would reject honest runs.
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
  /** Stop at the first mismatching checkpoint. On by default; tests disable it to see them all. */
  stopOnMismatch?: boolean;
}

/** Checkpoint hashes from the log, indexed by tick. */
function expectedByTick(log: RunLog): Map<number, string> {
  const map = new Map<number, string>();
  for (const checkpoint of log.checkpoints) map.set(checkpoint.tick, checkpoint.hash);
  return map;
}

/**
 * Frame at an index, with its tick verified.
 *
 * A log whose frames are out of order or renumbered is malformed rather than merely wrong, and saying
 * so here produces a clear rejection instead of a confusing hash mismatch a thousand ticks later.
 */
function frameAt(frames: readonly InputFrame[], index: number): InputFrame {
  const frame = frames[index];
  if (!frame) throw new ReplayError(`log has no frame at index ${index}`);
  if (frame.tick !== index) {
    throw new ReplayError(`frame ${index} claims tick ${frame.tick}`);
  }
  return frame;
}

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

  /*
   * The summary is derived entirely from replayed state, including medals. Taking medals from the log
   * would let a tampered log assert awards it never earned, which is the whole thing verification
   * exists to prevent.
   */
  return { summary: summary(sim), checkpoints, mismatchTick };
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
 * Replay a bounded slice of a log.
 *
 * Returns state to resume from, or null once the log is exhausted or a mismatch is found. The caller
 * persists that state between invocations; see the Verifier blueprint for the job chaining.
 */
export function replaySlice(options: SliceOptions): SliceResult {
  const { log, content, cursorTick, maxTicks } = options;

  if (maxTicks <= 0) throw new ReplayError('maxTicks must be positive');

  let sim: Simulation;
  if (options.state) {
    sim = restoreSimulation(log.matchConfig, content, options.state);
    if (sim.state.tick !== cursorTick) {
      throw new ReplayError(`restored state is at tick ${sim.state.tick}, expected ${cursorTick}`);
    }
    if (options.expectedResumeHash !== undefined) {
      const actual = hashSimulation(sim);
      if (actual !== options.expectedResumeHash) {
        throw new ReplayError(
          `restored state hash ${actual} does not match ${options.expectedResumeHash}`,
        );
      }
    }
  } else {
    if (cursorTick !== 0) throw new ReplayError('cursorTick must be 0 when starting fresh');
    sim = createSimulation(log.matchConfig, content);
  }

  const expected = expectedByTick(log);
  const checkpoints: StateCheckpoint[] = [];
  let mismatchTick: number | null = null;
  let index = cursorTick;
  const limit = Math.min(log.frames.length, cursorTick + maxTicks);

  for (; index < limit; index++) {
    step(sim, frameAt(log.frames, index));
    if (isEnded(sim)) {
      index += 1;
      // The final tick still produces a checkpoint, so fall through rather than breaking early.
    }
    if (isCheckpointTick(sim)) {
      const hash = hashSimulation(sim);
      checkpoints.push({ tick: sim.state.tick, hash });
      const want = expected.get(sim.state.tick);
      if (want !== undefined && want !== hash) {
        mismatchTick = sim.state.tick;
        break;
      }
    }
    if (isEnded(sim)) break;
  }

  const exhausted = index >= log.frames.length || isEnded(sim);
  const done = exhausted || mismatchTick !== null;

  return {
    state: done ? null : serializeSimulation(sim),
    cursorTick: index,
    checkpoints,
    mismatchTick,
    // Medals come from replayed state, never from the log. See the note in replay() above.
    summary: done && mismatchTick === null ? summary(sim) : null,
    done,
  };
}
