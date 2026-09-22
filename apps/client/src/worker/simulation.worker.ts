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
 * skipping the tick, so the tick count and therefore the round length never depend on input timing.
 *
 * Sim events are translated into HUD and visual events here, at the boundary, so the client never
 * imports gameplay internals and fixed-point values never leak into rendering code.
 */

/// <reference lib="webworker" />

import { Buttons, emptyInputFrame, type InputFrame } from '@rearena/protocol';
import {
  createSimulation,
  events as simEvents,
  hashSimulation,
  isCheckpointTick,
  isEnded,
  snapshot,
  step,
  summary,
  weaponByIndex,
  FixedMath,
  SIM_VERSION,
  type Simulation,
} from '@rearena/sim';
import type { HudEvent } from '../hud/hud.js';
import {
  NO_DEBUG,
  WORKER_PROTOCOL_VERSION,
  type DebugAction,
  type DebugFlags,
  type Point3,
  type VisualEvent,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol.js';

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
let pendingHud: HudEvent[] = [];
let pendingVisual: VisualEvent[] = [];
let lastButtons = 0;
/** Wave cursor from the previous tick, so a new wave can be announced once. */
let lastWaveCursor = 0;

/** Developer overrides. Using any of them taints the round permanently. */
let debug: DebugFlags = { ...NO_DEBUG };
let tainted = false;

function post(event: WorkerEvent): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(event);
}

function fail(message: string): void {
  running = false;
  post({ type: 'error', message });
}

/** Fixed point to float, at the boundary, so rendering code never sees Q16.16. */
function toPoint(v: { x: number; y: number; z: number }): Point3 {
  return { x: FixedMath.toFloat(v.x), y: FixedMath.toFloat(v.y), z: FixedMath.toFloat(v.z) };
}

/** Translate simulation events into the HUD and visual sets the client consumes. */
function collectEvents(current: Simulation): void {
  const tick = simEvents(current);

  for (const event of tick.combat) {
    switch (event.kind) {
      case 'shot':
        pendingVisual.push({ kind: 'muzzle', weaponIndex: event.weaponIndex ?? 0 });
        if (event.origin && event.end) {
          pendingVisual.push({
            kind: 'tracer',
            from: toPoint(event.origin),
            to: toPoint(event.end),
          });
        }
        break;
      case 'hit':
        pendingHud.push({ kind: 'hit' });
        if (event.end && event.impact) {
          pendingVisual.push({
            kind: 'impact',
            at: toPoint(event.end),
            onBody: event.targetId !== undefined,
          });
        }
        if (event.targetId !== undefined) {
          pendingVisual.push({ kind: 'enemyHit', id: event.targetId });
        }
        break;
      case 'headshot':
        pendingHud.push({ kind: 'headshot' });
        pendingVisual.push({ kind: 'headshot' });
        if (event.end) {
          pendingVisual.push({ kind: 'impact', at: toPoint(event.end), onBody: true });
        }
        if (event.targetId !== undefined) {
          pendingVisual.push({ kind: 'enemyHit', id: event.targetId });
        }
        break;
      case 'kill':
        pendingHud.push({ kind: 'kill' });
        pendingVisual.push({ kind: 'kill' });
        if (event.targetId !== undefined && event.end) {
          pendingVisual.push({
            kind: 'enemyDeath',
            id: event.targetId,
            at: toPoint(event.end),
          });
        }
        break;
      case 'dryFire':
        pendingHud.push({ kind: 'dryFire' });
        pendingVisual.push({ kind: 'dryFire' });
        break;
      case 'reloadStart':
        pendingHud.push({ kind: 'reloadStart' });
        pendingVisual.push({ kind: 'reloadStart' });
        break;
      default:
        break;
    }
  }

  for (const event of tick.enemy) {
    if (event.kind === 'playerHit') {
      pendingHud.push({ kind: 'damage' });
      pendingVisual.push({ kind: 'playerHurt' });
    } else if (event.kind === 'enemyShot') {
      const enemy = current.state.enemies.find((e) => e.id === event.enemyId);
      if (enemy) {
        pendingVisual.push({ kind: 'enemyShot', id: enemy.id, at: toPoint(enemy.pos) });
      }
    }
  }

  for (const medal of tick.medals) {
    pendingHud.push({ kind: 'medal', medal });
    pendingVisual.push({ kind: 'medal' });
  }

  if (current.state.waveCursor !== lastWaveCursor) {
    lastWaveCursor = current.state.waveCursor;
    pendingVisual.push({ kind: 'waveStart' });
  }
}

/**
 * Apply developer overrides.
 *
 * Called AFTER step(), never inside it. Keeping it outside means the simulation's own logic is
 * untouched by the cheat: nothing in movement, combat or scoring has a branch for invincibility, so
 * a debug path cannot accidentally leak into real gameplay.
 *
 * The cost is that the state no longer matches a clean replay of the same inputs, which is exactly
 * why it taints the run.
 */
function applyDebug(current: Simulation): void {
  if (!debug.invincible && !debug.infiniteAmmo) return;

  const p = current.state.player;

  if (debug.invincible) {
    p.health = current.content.maxHealth;
    // Clear a down timer too, or the player is frozen for three seconds at full health.
    p.downTicks = 0;
  }

  if (debug.infiniteAmmo) {
    const def = weaponByIndex(current.weaponIndices[p.weaponSlot] ?? 0);
    p.ammo[p.weaponSlot] = def.magazine;
    p.reserve[p.weaponSlot] = def.reserve;
    // Cancel a reload in progress: it would be refilling an already-full magazine.
    p.reloadTicks = 0;
  }
}

function applyDebugAction(current: Simulation, action: DebugAction): void {
  switch (action.kind) {
    case 'clearWave':
      // Drop health to zero rather than splicing the array, so kill bookkeeping stays consistent.
      for (const enemy of current.state.enemies) enemy.health = 0;
      current.state.enemies = [];
      break;
    case 'setWave':
      current.state.waveCursor = Math.max(0, Math.floor(action.wave));
      lastWaveCursor = current.state.waveCursor;
      break;
    case 'endRound':
      current.state.ended = 1;
      break;
  }
}

/** Spread as a fraction of the weapon's maximum, for the crosshair gap. */
function normalisedSpread(current: Simulation): number {
  const slot = current.state.player.weaponSlot;
  const def = weaponByIndex(current.weaponIndices[slot] ?? 0);
  const max = FixedMath.toFloat(def.spreadMax);
  if (max <= 0) return 0;
  return Math.min(1, FixedMath.toFloat(current.state.player.spreadBloom) / max);
}

/**
 * How far through a reload the player is, 0 to 1.
 *
 * Computed against the equipped weapon's own reloadTicks rather than a constant, so the animation
 * stages line up whether the reload takes 1.4 s or 2.1 s.
 */
function reloadProgress(current: Simulation): number {
  const remaining = current.state.player.reloadTicks;
  if (remaining <= 0) return 0;
  const slot = current.state.player.weaponSlot;
  const def = weaponByIndex(current.weaponIndices[slot] ?? 0);
  if (def.reloadTicks <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - remaining / def.reloadTicks));
}

/** Horizontal speed in units per second, for sway and bob. */
function horizontalSpeed(current: Simulation): number {
  const v = current.state.player.vel;
  const x = FixedMath.toFloat(v.x);
  const z = FixedMath.toFloat(v.z);
  return Math.sqrt(x * x + z * z) * 60;
}

function takeFrame(tick: number): InputFrame {
  while (inputQueue.length > 0) {
    const head = inputQueue[0]!;
    if (head.tick === tick) {
      inputQueue.shift();
      lastButtons = head.buttons;
      return head;
    }
    if (head.tick < tick) {
      inputQueue.shift();
      continue;
    }
    break;
  }
  lastButtons = 0;
  return emptyInputFrame(tick);
}

function runTicks(count: number): void {
  if (!sim) return;
  for (let i = 0; i < count; i++) {
    if (isEnded(sim)) break;
    const frame = takeFrame(sim.state.tick);
    step(sim, frame);
    applyDebug(sim);
    collectEvents(sim);
    if (isCheckpointTick(sim)) {
      post({
        type: 'checkpoint',
        checkpoint: { tick: sim.state.tick, hash: hashSimulation(sim) },
      });
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
    // The tab was throttled or the device stalled. Run a bounded number of ticks and drop the rest
    // of the backlog: chasing it would freeze the thread, and since the sim has no clock, dropping
    // it costs wall-clock time in the round rather than correctness.
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
    post({
      type: 'snapshot',
      snapshot: snapshot(sim),
      hudEvents: pendingHud,
      visualEvents: pendingVisual,
      spread: normalisedSpread(sim),
      speed: horizontalSpeed(sim),
      reloadProgress: reloadProgress(sim),
      aiming: (lastButtons & Buttons.Aim) !== 0,
      grounded: sim.state.player.grounded === 1,
      tainted,
    });
    pendingHud = [];
    pendingVisual = [];
  }

  if (isEnded(sim)) {
    running = false;
    post({ type: 'ended', summary: summary(sim), tainted });
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
        pendingHud = [];
        pendingVisual = [];
        lastWaveCursor = 0;
        accumulator = 0;
        // A fresh round starts clean, whatever the previous one did.
        debug = { ...NO_DEBUG };
        tainted = false;
        post({ type: 'ready', protocolVersion: WORKER_PROTOCOL_VERSION, simVersion: SIM_VERSION });
        post({
          type: 'snapshot',
          snapshot: snapshot(sim),
          hudEvents: [],
          visualEvents: [],
          spread: 0,
          speed: 0,
          reloadProgress: 0,
          aiming: false,
          grounded: true,
          tainted: false,
        });
        return;
      }
      case 'input': {
        inputQueue.push(command.frame);
        return;
      }
      case 'debug': {
        if (!sim) return;
        if (command.flags) {
          debug = { ...debug, ...command.flags };
          if (debug.invincible || debug.infiniteAmmo) tainted = true;
        }
        if (command.action) {
          applyDebugAction(sim, command.action);
          tainted = true;
        }
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
