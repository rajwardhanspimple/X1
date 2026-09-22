/**
 * Client entry: boot the renderer, start the simulation, pump input, draw interpolated state.
 *
 * What is deliberately temporary here:
 *  - placeholder SimContent, until the content manifest lands (WO-10) and the first map is
 *    authored (WO-52)
 *  - a one-file round lifecycle, until RoundOrchestrator and the React shell land (WO-47)
 *  - a free camera driven from the player pose, until FirstPersonCamera lands (WO-49)
 *
 * What is not temporary: the input pump runs on its own fixed 60 Hz cadence, not inside the render
 * loop. If it were tied to frames, a 30 fps device would feed the simulation half as many frames as
 * a 120 fps one and the same play would produce a different run.
 */

import './styles.css';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { MatchConfig, RunSummary, StateCheckpoint } from '@rearena/protocol';
import { FixedMath, SIM_VERSION, type SimContent } from '@rearena/sim';
import { bootEngine, observeResize } from './engine/bootstrap.js';
import { buildArena } from './render/arena.js';
import { FrameStats } from './render/frame-stats.js';
import { interpolate } from './render/interpolator.js';
import { SimulationHost } from './worker/host.js';
import { KeyboardMouseAdapter } from './input/keyboard-mouse.js';
import { PointerLockManager } from './input/pointer-lock.js';
import { InputRouter } from './input/router.js';
import { RunRecorder } from './input/recorder.js';

const TICK_MS = 1000 / 60;
const COUNTDOWN_MS = 2000;
const BUILD_ID = import.meta.env.VITE_BUILD_ID ?? 'dev';

/** Stand-in for a published map. Values are plain and stable; gameplay tuning comes with content. */
const PLACEHOLDER_CONTENT: SimContent = {
  hash: 'greybox-arena-01',
  durationTicks: 60 * 60 * 3, // three minutes
  spawn: { x: 0, y: 0, z: FixedMath.fromInt(-22) },
  spawnYaw: 0,
  maxHealth: FixedMath.fromInt(100),
  magazine: [30, 12],
  reserve: [120, 48],
};

function placeholderConfig(): MatchConfig {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  return {
    mapId: 'greybox-arena',
    modeId: 'survival',
    seed: seed[0]! >>> 0,
    simVersion: SIM_VERSION,
    contentHash: PLACEHOLDER_CONTENT.hash,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');

function status(text: string): void {
  if (bootStatus) {
    delete bootStatus.dataset.error;
    bootStatus.textContent = text;
  }
  if (boot) delete boot.dataset.hidden;
}

function hideBoot(): void {
  if (boot) boot.dataset.hidden = 'true';
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (bootStatus) {
    bootStatus.dataset.error = 'true';
    bootStatus.textContent = `Could not start. ${message}`;
  }
  if (boot) delete boot.dataset.hidden;
  console.error(error);
}

async function start(): Promise<void> {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas element is missing');

  status('starting renderer');
  const { engine, backend, deviceClass, pixelRatio } = await bootEngine(canvas);
  console.info(`renderer ${backend}, ${deviceClass}, pixel ratio ${pixelRatio}`);

  status('building arena');
  const arena = buildArena(engine);
  const stats = new FrameStats(engine, `${backend} ${deviceClass}`);
  const stopResize = observeResize(engine, canvas);

  const recorder = new RunRecorder(BUILD_ID);
  const adapter = new KeyboardMouseAdapter(canvas);
  const pointerLock = new PointerLockManager(canvas, {
    onChange(state) {
      // Escape releases the lock and the browser reserves that key, so treat an unlock during play
      // as the player asking to pause rather than fighting for the cursor back.
      if (state === 'unlocked' && router.currentPhase() === 'playing') pause();
      if (state === 'denied') {
        status('This browser blocked mouse capture. Click the view and allow pointer lock to aim.');
      }
    },
  });

  const host = new SimulationHost({
    onCheckpoint(checkpoint: StateCheckpoint) {
      recorder.appendCheckpoint(checkpoint);
    },
    onEnded(summary: RunSummary) {
      const log = recorder.finish(summary);
      router.setPhase('ended');
      pointerLock.release();
      // WO-40 submits this log; for now the result is local and logged.
      console.info('round ended', summary, log ? `${log.frames.length} frames` : 'no log');
      status(`round over. score ${summary.score}. click to play again`);
    },
    onError(message) {
      fail(new Error(message));
    },
  });

  const router = new InputRouter(adapter, {
    onFrame(frame) {
      recorder.appendFrame(frame);
    },
    onPausePressed() {
      if (router.currentPhase() === 'playing') pause();
      else if (router.currentPhase() === 'paused') void resume();
    },
  });

  let pump: ReturnType<typeof setInterval> | null = null;

  /**
   * One frame per simulation tick. The worker is authoritative on tick count; this follows it and
   * emits a frame for every tick that has not been fed yet, so a late interval callback catches up
   * instead of dropping input.
   */
  let fedThroughTick = -1;
  function pumpInput(): void {
    const target = host.currentTick();
    // Cap the catch-up so a long stall cannot post thousands of messages at once.
    const from = Math.max(fedThroughTick + 1, target - 8);
    for (let tick = from; tick <= target; tick++) {
      const frame = router.buildFrame(tick);
      host.sendInput(frame);
      router.commit(frame);
      fedThroughTick = tick;
    }
  }

  function startPump(): void {
    if (pump !== null) return;
    pump = setInterval(pumpInput, TICK_MS);
  }

  function stopPump(): void {
    if (pump === null) return;
    clearInterval(pump);
    pump = null;
  }

  function pause(): void {
    if (router.currentPhase() !== 'playing') return;
    router.setPhase('paused');
    host.pause();
    stopPump();
    pointerLock.release();
    status('paused. click to resume');
  }

  async function resume(): Promise<void> {
    if (router.currentPhase() !== 'paused') return;
    await pointerLock.request();
    hideBoot();
    // A short countdown on resume, so the player is not shot while finding the cursor again.
    router.setPhase('countdown');
    startPump();
    host.resume();
    setTimeout(() => {
      if (router.currentPhase() === 'countdown') router.setPhase('playing');
    }, 1000);
  }

  async function beginRound(): Promise<void> {
    const config = placeholderConfig();
    recorder.discard();
    recorder.begin(config);
    fedThroughTick = -1;
    router.setPhase('countdown');
    await host.start(config, PLACEHOLDER_CONTENT);
    await pointerLock.request();
    hideBoot();
    startPump();
    setTimeout(() => {
      if (router.currentPhase() === 'countdown') router.setPhase('playing');
    }, COUNTDOWN_MS);
  }

  // Pointer lock needs a user gesture, so the round starts on the first click.
  canvas.addEventListener('click', () => {
    const phase = router.currentPhase();
    if (phase === 'idle' || phase === 'ended') void beginRound().catch(fail);
    else if (phase === 'paused') void resume();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyF' && !event.repeat && !event.metaKey && !event.ctrlKey) stats.toggle();
  });

  const eye = new Vector3();
  const target = new Vector3();

  engine.runRenderLoop(() => {
    const frame = interpolate(host.snapshots(), performance.now());
    if (frame) {
      const p = frame.player;
      // Turns to radians for Babylon, at the very last step.
      const yawRad = p.yaw * Math.PI * 2;
      const pitchRad = p.pitch * Math.PI * 2;
      eye.set(p.x, p.y + 1.7, p.z);
      target.set(
        eye.x + Math.sin(yawRad) * Math.cos(pitchRad),
        eye.y + Math.sin(pitchRad),
        eye.z + Math.cos(yawRad) * Math.cos(pitchRad),
      );
      arena.camera.position.copyFrom(eye);
      arena.camera.setTarget(target);
    }
    arena.scene.render();
    stats.sample();
  });

  status('click to play');

  window.addEventListener('beforeunload', () => {
    // A closed page submits nothing partial (AC-ARM-006.5).
    recorder.discard();
    stopPump();
    host.dispose();
    pointerLock.dispose();
    adapter.dispose();
    stopResize();
    stats.dispose();
    arena.dispose();
    engine.dispose();
  });
}

start().catch(fail);
