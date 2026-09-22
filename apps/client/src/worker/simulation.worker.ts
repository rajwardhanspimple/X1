/**
 * Simulation worker.
 *
 * The kernel runs here, off the main thread, at a fixed 60 Hz. The worker's clock is used for
 * PACING ONLY: it decides *when* to run a tick, never *what* a tick produces. The simulation
 * itself reads no clock (AC-ARM-007.3), so a slow frame, a fast phone or a background tab changes
 * the wall-clock duration of a round but not its outcome.
 *
 * Input handling matters for determinism: exactly one InputFrame is consumed per tick. If the main
 * thread has not delivered one in time, the worker substitutes an explicit empty frame rather than
 * skipping the tick, so the tick count and therefore the round length never depend on input
 * timing. The frame the worker actually consumed is what the main thread records into the RunLog.
 */

/// <reference lib="webworker" />

import { emptyInputFrame, type InputFrame } from '@rearena/protocol';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  isEnded,
  snapshot,
  step,
  summary,
  SIM_VERSION,
  type Simulation,
} from '@rearena/sim';
import { WORKER_PROTOCOL_VERSION, type WorkerCommand, type WorkerEvent } from './protocol.js';

const TICK_MS = 1000 / 60;
const DEFAULT_MAX_CATCH_UP = 8;

let sim: Simulation | null = null;
let running = false;
let disposed = false;
let accumulator = 0;
let lastTime = 0;
let maxCatchUpTicks = DEFAULT_MAX_CATCH_UP;
let timer: ReturnType<typeof setTimeout> | null = null;

const inputQueue: InputFrame[] = [];

function post(event: WorkerEvent): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(event);
}

function fail(message: string): void {
  running = false;
  post({ type: 'error', message });
}

/**
 * Take the frame for this tick.
 *
 * A queued frame is used only if it is for the tick about to run. A frame for an older tick is
 * stale (the main thread was late) and is dropped; a frame for a future tick is left in place.
 * Either way the tick still happens, with an empty frame if needed.
 */
function takeFrame(tick: number): InputFrame {
  while (inputQueue.length > 0) {
    const head = inputQueue[0]!;
    if (head.tick === tick) {
      inputQueue.shift();
      return head;
    }
    if (head.tick < tick) {
      inputQueue.shift();
      continue;
    }
    break;
  }
  return emptyInputFrame(tick);
}

function runTicks(count: number): void {
  if (!sim) return;
  for (let i = 0; i < count; i++) {
    if (isEnded(sim)) break;
    const frame = takeFrame(sim.state.tick);
    step(sim, frame);
    if (isCheckpointTick(sim)) {
      post({ type: 'checkpoint', checkpoint: { tick: sim.state.tick, hash: hashSimulation(sim) } });
    }
  }
}

function loop(): void {
  if (disposed || !running || !sim) return;

  const now = Date.now();
  const elapsed = Math.min(now - lastTime, 1000);
  lastTime = now;
  accumulator += elapsed;

  let ticks = Math.floor(accumulator / TICK_MS);
  if (ticks > maxCatchUpTicks) {
    // The tab was throttled or the device stalled. Run a bounded number of ticks and drop the
    // rest of the backlog: chasing it would freeze the thread and, since the sim has no clock,
    // dropping it costs wall-clock time in the round, not correctness.
    ticks = maxCatchUpTicks;
    accumulator = 0;
  } else {
    accumulator -= ticks * TICK_MS;
  }

  if (ticks > 0) {
    try {
      runTicks(ticks);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    post({ type: 'snapshot', snapshot: snapshot(sim) });
  }

  if (isEnded(sim)) {
    running = false;
    post({ type: 'ended', summary: summary(sim) });
    return;
  }

  // setTimeout rather than requestAnimationFrame: a worker has no frames, and the simulation must
  // keep its rate even when the tab is not painting.
  const delay = Math.max(0, TICK_MS - (Date.now() - now));
  timer = setTimeout(loop, delay);
}

function stopTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  try {
    switch (command.type) {
      case 'init': {
        if (command.protocolVersion !== WORKER_PROTOCOL_VERSION) {
          fail(
            `worker protocol ${WORKER_PROTOCOL_VERSION} does not match page ${command.protocolVersion}; reload required`,
          );
          return;
        }
        maxCatchUpTicks = command.maxCatchUpTicks ?? DEFAULT_MAX_CATCH_UP;
        sim = createSimulation(command.config, command.content);
        inputQueue.length = 0;
        accumulator = 0;
        post({ type: 'ready', protocolVersion: WORKER_PROTOCOL_VERSION, simVersion: SIM_VERSION });
        post({ type: 'snapshot', snapshot: snapshot(sim) });
        return;
      }
      case 'input': {
        inputQueue.push(command.frame);
        return;
      }
      case 'start':
      case 'resume': {
        if (!sim) {
          fail('received start before init');
          return;
        }
        if (running) return;
        running = true;
        lastTime = Date.now();
        accumulator = 0;
        stopTimer();
        loop();
        return;
      }
      case 'pause': {
        running = false;
        stopTimer();
        // Queued input is dropped on pause: it was produced for ticks that will not run now, and
        // AC-ARM-004.2 requires that nothing advances while paused.
        inputQueue.length = 0;
        return;
      }
      case 'dispose': {
        disposed = true;
        running = false;
        stopTimer();
        sim = null;
        return;
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};
