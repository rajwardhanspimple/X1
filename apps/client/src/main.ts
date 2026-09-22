/**
 * Client entry: boot the renderer, start the simulation, pump input, present the result.
 *
 * Temporary until their work orders land:
 *  - content is the built-in greybox layout, not a published manifest (WO-10, WO-52)
 *  - the round lifecycle lives here rather than in RoundOrchestrator and a React shell (WO-47)
 *
 * Not temporary: the input pump runs on its own fixed 60 Hz cadence, not inside the render loop.
 * Tied to frames, a 30 fps device would feed the simulation half as many frames as a 120 fps one
 * and the same play would produce a different run.
 */

import './styles.css';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { MatchConfig, RunSummary, StateCheckpoint } from '@rearena/protocol';
import {
  createGreyboxWorld,
  greyboxEnemySpawns,
  greyboxPlayerSpawns,
  FixedMath,
  GREYBOX_SPAWNS,
  SIM_VERSION,
  type SimContent,
} from '@rearena/sim';
import { bootEngine, observeResize } from './engine/bootstrap.js';
import { buildArena } from './render/arena.js';
import { CameraRig } from './render/camera-rig.js';
import { EnemyRenderer } from './render/enemies.js';
import { CasingPool, ImpactPool, TracerPool } from './render/effects.js';
import { WeaponViewModel } from './render/weapon-view.js';
import { FrameStats } from './render/frame-stats.js';
import { interpolate } from './render/interpolator.js';
import { AudioEngine } from './audio/engine.js';
import { Hud } from './hud/hud.js';
import { SimulationHost } from './worker/host.js';
import { KeyboardMouseAdapter } from './input/keyboard-mouse.js';
import { PointerLockManager } from './input/pointer-lock.js';
import { InputRouter } from './input/router.js';
import { RunRecorder } from './input/recorder.js';

const TICK_MS = 1000 / 60;
const COUNTDOWN_MS = 1500;
const BUILD_ID = import.meta.env.VITE_BUILD_ID ?? 'dev';

/**
 * Built-in content. Collision boxes come from the same layout the renderer draws, so there is one
 * arena definition rather than two that can drift.
 */
function greyboxContent(): SimContent {
  const world = createGreyboxWorld();
  const spawn = GREYBOX_SPAWNS[0]!;
  return {
    hash: 'greybox-arena-03',
    durationTicks: 60 * 60 * 3, // three minutes
    boxes: world.boxes,
    bounds: world.bounds,
    spawns: greyboxPlayerSpawns(),
    spawnYaw: FixedMath.fromRatio(Math.round(spawn.yaw * 1000), 1000),
    enemySpawns: greyboxEnemySpawns(),
    maxHealth: FixedMath.fromInt(100),
    weapons: ['rifle-01', 'pistol-01'],
  };
}

const CONTENT = greyboxContent();

function newConfig(): MatchConfig {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  return {
    mapId: 'greybox-arena',
    modeId: 'survival',
    seed: seed[0]! >>> 0,
    simVersion: SIM_VERSION,
    contentHash: CONTENT.hash,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const hudRoot = document.getElementById('hud-root');

function status(text: string): void {
  if (bootStatus) {
    delete bootStatus.dataset.error;
    bootStatus.textContent = text;
  }
  if (boot) delete boot.dataset.hidden;
  console.info(`[rearena] ${text}`);
}

function hidePrompt(): void {
  if (boot) boot.dataset.hidden = 'true';
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (bootStatus) {
    bootStatus.dataset.error = 'true';
    bootStatus.textContent = `Could not start. ${message}`;
  }
  if (boot) delete boot.dataset.hidden;
  console.error('[rearena]', error);
}

async function start(): Promise<void> {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas element is missing');
  if (!hudRoot) throw new Error('hud root is missing');

  status('starting renderer');
  const { engine, backend, deviceClass, pixelRatio } = await bootEngine(canvas);
  console.info(`[rearena] renderer ${backend}, ${deviceClass}, pixel ratio ${pixelRatio}`);

  status('building arena');
  const arena = buildArena(engine, deviceClass);
  const camera = new CameraRig(arena.camera);
  const enemies = new EnemyRenderer(arena.scene);
  const tracers = new TracerPool(arena.scene);
  const impacts = new ImpactPool(arena.scene);
  const casings = new CasingPool(arena.scene);
  const weapon = new WeaponViewModel(arena.scene, arena.camera);
  const audio = new AudioEngine();
  const hud = new Hud(hudRoot);
  const stats = new FrameStats(engine, `${backend} ${deviceClass}`);
  const stopResize = observeResize(engine, canvas);

  const recorder = new RunRecorder(BUILD_ID);
  const adapter = new KeyboardMouseAdapter(canvas);
  const pointerLock = new PointerLockManager(canvas, {
    onChange(state) {
      console.info(`[rearena] pointer lock ${state}`);
      // Escape releases the lock and the browser reserves that key, so treat an unlock during play
      // as the player asking to pause rather than fighting for the cursor back.
      if (state === 'unlocked' && router.currentPhase() === 'playing') pause();
      if (state === 'denied') {
        status('Mouse capture was blocked. Click the view and allow pointer lock to aim.');
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
      // WO-40 submits this log; for now the result is local.
      console.info('[rearena] round ended', summary, log ? `${log.frames.length} frames` : 'no log');
      const accuracy = (summary.accuracyBp / 100).toFixed(1);
      status(
        `round over. ${summary.score} points, ${summary.kills} kills, ${accuracy}% accuracy. click to play again`,
      );
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
  let fedThroughTick = -1;

  /**
   * One frame per simulation tick. The worker is authoritative on tick count; this follows it and
   * emits a frame for every tick not yet fed, so a late interval callback catches up rather than
   * dropping input.
   */
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
    hidePrompt();
    router.setPhase('countdown');
    startPump();
    host.resume();
    setTimeout(() => {
      if (router.currentPhase() === 'countdown') router.setPhase('playing');
    }, 800);
  }

  async function beginRound(): Promise<void> {
    status('starting simulation');
    const config = newConfig();
    recorder.discard();
    recorder.begin(config);
    fedThroughTick = -1;
    router.setPhase('countdown');
    await host.start(config, CONTENT);
    console.info('[rearena] simulation ready, seed', config.seed);
    await pointerLock.request();
    hidePrompt();
    startPump();
    setTimeout(() => {
      if (router.currentPhase() === 'countdown') {
        router.setPhase('playing');
        console.info(
          '[rearena] round live: WASD move, Shift sprint, C crouch, Space jump, Mouse1 fire, Mouse2 aim, R reload, Q swap, M mute',
        );
      }
    }, COUNTDOWN_MS);
  }

  /**
   * Pointer lock and audio both need a user gesture, so both are requested from the same handler.
   * The listener is on window rather than the canvas so no overlay can intercept it.
   */
  function onStartGesture(): void {
    void audio.unlock();
    const phase = router.currentPhase();
    if (phase === 'idle' || phase === 'ended') void beginRound().catch(fail);
    else if (phase === 'paused') void resume();
  }

  window.addEventListener('click', onStartGesture);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Enter') onStartGesture();
    if (event.code === 'KeyF' && !event.repeat && !event.metaKey && !event.ctrlKey) stats.toggle();
    if (event.code === 'KeyM' && !event.repeat) {
      const muted = audio.toggleMute();
      console.info(`[rearena] audio ${muted ? 'muted' : 'unmuted'}`);
    }
  });

  document.addEventListener('visibilitychange', () => {
    audio.setSuspended(document.hidden);
    if (document.hidden) pause();
  });

  const tracerTo = new Vector3();
  const impactAt = new Vector3();
  const soundAt = new Vector3();
  let firstFrame = true;

  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = engine.getDeltaTime() / 1000;
    const frame = interpolate(host.snapshots(), now);
    const view = host.viewState();

    if (frame) {
      const p = frame.player;
      camera.update({
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        speed: view.speed,
        grounded: view.grounded,
        aiming: view.aiming,
        dt,
      });

      // The listener follows the camera, so a shot behind the player sounds behind them.
      const position = camera.position();
      const forward = camera.forward();
      audio.setListener(position, forward);

      // Footsteps fire from the camera's own walk cycle, so the sound lands on the visible
      // footfall rather than on an independent timer that would drift out of sync with the bob.
      if (camera.consumeFootstep()) {
        audio.footstep(position, true);
      }

      enemies.update(frame, now, dt);
      hud.update(frame.discrete, now);
      hud.setSpread(view.spread);
      hud.handleEvents(host.drainHudEvents(), now);
    }

    weapon.update({
      now,
      dt,
      aiming: view.aiming,
      reloading: view.reloading,
      movingSpeed: view.speed,
    });

    for (const event of host.drainVisualEvents()) {
      switch (event.kind) {
        case 'muzzle': {
          weapon.onShot(now);
          camera.onShot();
          audio.playerShot(event.weaponIndex);
          // Eject a casing from the weapon, thrown to the right of where the player is looking.
          casings.spawn(weapon.muzzleWorldPosition(), camera.forward(), now);
          break;
        }
        case 'tracer': {
          // Start at the muzzle, not the eye: a tracer from the centre of the screen looks like it
          // comes out of the player's face.
          tracerTo.set(event.to.x, event.to.y, event.to.z);
          tracers.spawn({ from: weapon.muzzleWorldPosition(), to: tracerTo }, now);
          break;
        }
        case 'impact': {
          impactAt.set(event.at.x, event.at.y, event.at.z);
          impacts.spawn({ at: impactAt, onBody: event.onBody }, now);
          audio.impact(impactAt, event.onBody);
          break;
        }
        case 'enemyHit':
          enemies.onHit(event.id, now);
          break;
        case 'enemyDeath':
          enemies.onDeath(event.id, now);
          soundAt.set(event.at.x, event.at.y, event.at.z);
          audio.enemyDeath(soundAt);
          break;
        case 'enemyShot':
          // Flash that figure's muzzle so the player can see which one fired.
          enemies.onShot(event.id, now);
          soundAt.set(event.at.x, event.at.y, event.at.z);
          audio.enemyShot(soundAt);
          break;
        case 'playerHurt':
          camera.onDamage(1);
          audio.playerHurt();
          break;
        case 'kill':
          audio.kill();
          break;
        case 'headshot':
          audio.headshot();
          break;
        case 'reload':
          weapon.onReloadStart();
          audio.reload();
          break;
        case 'dryFire':
          audio.dryFire();
          break;
        case 'medal':
          audio.medal();
          break;
        case 'waveStart':
          audio.waveStart();
          break;
      }
    }

    tracers.update(now);
    impacts.update(now);
    casings.update(now, dt);

    arena.scene.render();
    stats.sample();

    if (firstFrame) {
      firstFrame = false;
      // Register enemy meshes as shadow casters once they exist in the pool.
      arena.addShadowCasters(enemies.shadowCasters());
      // The arena is on screen, so stop covering it. The prompt stays readable on top.
      if (boot) boot.dataset.transparent = 'true';
      console.info('[rearena] first frame rendered');
    }
  });

  status('click or press enter to play');

  window.addEventListener('beforeunload', () => {
    // A closed page submits nothing partial (AC-ARM-006.5).
    recorder.discard();
    stopPump();
    host.dispose();
    pointerLock.dispose();
    adapter.dispose();
    stopResize();
    hud.dispose();
    audio.dispose();
    weapon.dispose();
    casings.dispose();
    tracers.dispose();
    impacts.dispose();
    enemies.dispose();
    stats.dispose();
    arena.dispose();
    engine.dispose();
  });
}

start().catch(fail);
