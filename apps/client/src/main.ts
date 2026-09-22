/**
 * Client entry: wire the pieces together.
 *
 * This file is deliberately only wiring. The round lifecycle belongs to RoundOrchestrator, gameplay
 * to the simulation worker, presentation to the renderers and screens. When the lifecycle lived here
 * every new state added a branch to a growing conditional; keeping it out means this file changes
 * only when a new subsystem is added.
 *
 * Still temporary: content is the built-in greybox layout rather than a published manifest (WO-10,
 * WO-52), and the screens are plain DOM rather than the React shell.
 *
 * Not temporary: the input pump runs on its own fixed 60 Hz cadence, not inside the render loop.
 * Tied to frames, a 30 fps device would feed the simulation half as many frames as a 120 fps one and
 * the same play would produce a different run.
 */

import './styles.css';
import './touch.css';
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
import { RoundOrchestrator, type RoundState } from './game/round-orchestrator.js';
import { buildArena } from './render/arena.js';
import { CameraRig } from './render/camera-rig.js';
import { EnemyRenderer } from './render/enemies.js';
import { CasingPool, ImpactPool, TracerPool } from './render/effects.js';
import { WeaponViewModel } from './render/weapon-view.js';
import { FrameStats } from './render/frame-stats.js';
import { interpolate } from './render/interpolator.js';
import { AudioEngine } from './audio/engine.js';
import { Hud } from './hud/hud.js';
import { Screens, type MapOption, type ModeOption } from './hud/screens.js';
import { deviceSupportsTouch, TouchOverlay } from './hud/touch-overlay.js';
import { SimulationHost } from './worker/host.js';
import { GamepadAdapter } from './input/gamepad.js';
import { KeyboardMouseAdapter } from './input/keyboard-mouse.js';
import { PointerLockManager } from './input/pointer-lock.js';
import { InputRouter } from './input/router.js';
import { RunRecorder } from './input/recorder.js';

const TICK_MS = 1000 / 60;
const BUILD_ID = import.meta.env.VITE_BUILD_ID ?? 'dev';
const SELECTION_KEY = 'rearena.selection.v1';

/** One arena and one mode until content authoring lands (WO-52). */
const MAPS: readonly MapOption[] = [
  { id: 'greybox-arena', name: 'Greybox Arena', detail: 'Symmetric. Cover, pillars, two stairs.' },
];

const MODES: readonly ModeOption[] = [
  {
    id: 'survival',
    name: 'Survival',
    detail: 'Three minutes. Waves grow. Score as much as you can.',
  },
];

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

/** Selection persists per device, per AC-ARM-001.3. */
function loadSelection(): { mapId: string; modeId: string } {
  const fallback = { mapId: MAPS[0]!.id, modeId: MODES[0]!.id };
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { mapId?: string; modeId?: string };
    return {
      mapId: MAPS.some((m) => m.id === parsed.mapId) ? parsed.mapId! : fallback.mapId,
      modeId: MODES.some((m) => m.id === parsed.modeId) ? parsed.modeId! : fallback.modeId,
    };
  } catch {
    // Private browsing or a corrupt value: fall back rather than failing to start.
    return fallback;
  }
}

function saveSelection(selection: { mapId: string; modeId: string }): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    // Storage unavailable. The round still plays; only the preference is lost.
  }
}

function configFor(selection: { mapId: string; modeId: string }): MatchConfig {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  return {
    mapId: selection.mapId,
    modeId: selection.modeId,
    seed: seed[0]! >>> 0,
    simVersion: SIM_VERSION,
    contentHash: CONTENT.hash,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

async function start(): Promise<void> {
  const canvas = document.getElementById('game');
  const hudRoot = document.getElementById('hud-root');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas element is missing');
  if (!hudRoot) throw new Error('hud root is missing');

  const { engine, backend, deviceClass, pixelRatio } = await bootEngine(canvas);
  console.info(`[rearena] renderer ${backend}, ${deviceClass}, pixel ratio ${pixelRatio}`);

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

  /** Touch only exists on a device that reports it, so desktop pays nothing for it. */
  const touchCapable = deviceSupportsTouch();
  const touch = touchCapable
    ? new TouchOverlay(document.body, {
        onPausePressed() {
          orchestrator.togglePause();
        },
      })
    : null;
  touch?.setEnabled(true);

  /** The pad adapter is always created; it reports idle when nothing is connected. */
  const gamepad = new GamepadAdapter({
    onConnect(family, id) {
      console.info(`[rearena] gamepad connected: ${family} (${id})`);
    },
    onDisconnect() {
      console.info('[rearena] gamepad disconnected');
      // Losing the pad mid-round would leave the player standing still, so pause instead.
      if (orchestrator.current() === 'playing') orchestrator.dispatch('pause');
    },
  });

  let selection = loadSelection();

  const pointerLock = new PointerLockManager(canvas, {
    onChange(state) {
      // Escape releases the lock and the browser reserves that key, so an unlock during play is
      // treated as the player asking to pause rather than something to fight.
      if (state === 'unlocked' && orchestrator.current() === 'playing') {
        orchestrator.dispatch('pause');
      }
    },
  });

  const host = new SimulationHost({
    onCheckpoint(checkpoint: StateCheckpoint) {
      recorder.appendCheckpoint(checkpoint);
    },
    onEnded(summary: RunSummary) {
      const log = recorder.finish(summary);
      console.info('[rearena] round ended', summary, log ? `${log.frames.length} frames` : 'no log');
      // WO-40 submits the log; until then the result is explicitly local.
      orchestrator.finish(summary);
    },
    onError(message) {
      console.error('[rearena] simulation error', message);
      screens.setError(`Simulation failed. ${message}`);
      orchestrator.dispatch('quit');
    },
  });

  const router = new InputRouter(adapter, {
    onFrame(frame) {
      recorder.appendFrame(frame);
    },
    onPausePressed() {
      orchestrator.togglePause();
    },
    onSchemeChange(scheme) {
      console.info(`[rearena] input scheme ${scheme}`);
    },
  });
  if (touch) router.setTouchAdapter(touch.adapter);
  router.setGamepadAdapter(gamepad);

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
    if (pump === null) pump = setInterval(pumpInput, TICK_MS);
  }

  function stopPump(): void {
    if (pump !== null) {
      clearInterval(pump);
      pump = null;
    }
  }

  const orchestrator = new RoundOrchestrator({
    async onLoad() {
      saveSelection(selection);
      const config = configFor(selection);
      recorder.discard();
      recorder.begin(config);
      fedThroughTick = -1;
      await host.start(config, CONTENT);
      console.info('[rearena] simulation ready, seed', config.seed);
      // Input flows from the countdown onward, so the player can look around while it runs.
      startPump();
    },
    onPlay() {
      // Pointer lock is meaningless on touch: there is no cursor to capture and the request fails.
      if (!touchCapable) void pointerLock.request();
    },
    onPause() {
      host.pause();
      pointerLock.release();
    },
    onResume() {
      if (!touchCapable) void pointerLock.request();
      host.resume();
    },
    onAbandon() {
      // A discarded round submits nothing (AC-ARM-006.4).
      recorder.discard();
      stopPump();
      host.dispose();
      pointerLock.release();
    },
    onStateChange(state: RoundState, previous: RoundState) {
      console.info(`[rearena] ${previous} -> ${state}`);
      screens.show(state);
      // Touch controls belong on screen only while a round is live.
      touch?.setVisible(state === 'countdown' || state === 'playing');
      // The router mirrors the orchestrator: look-only during countdown, full control when playing.
      router.setPhase(
        state === 'playing'
          ? 'playing'
          : state === 'countdown'
            ? 'countdown'
            : state === 'paused'
              ? 'paused'
              : state === 'results'
                ? 'ended'
                : 'idle',
      );
      if (state === 'results') {
        const summary = orchestrator.lastSummary();
        if (summary) screens.setResults(summary);
      }
    },
    onError(error) {
      console.error('[rearena]', error);
      screens.setError(error instanceof Error ? error.message : String(error));
    },
  });

  const screens = new Screens(hudRoot, MAPS, MODES, {
    onAction(action, value) {
      // Audio needs a user gesture, and every screen action is one.
      void audio.unlock();
      switch (action) {
        case 'selectMap':
          if (value) {
            selection = { ...selection, mapId: value };
            screens.setSelection(selection.mapId, selection.modeId);
            saveSelection(selection);
          }
          return;
        case 'selectMode':
          if (value) {
            selection = { ...selection, modeId: value };
            screens.setSelection(selection.mapId, selection.modeId);
            saveSelection(selection);
          }
          return;
        case 'toggleMute':
          screens.setMuted(audio.toggleMute());
          return;
        default:
          orchestrator.dispatch(action);
      }
    },
  });

  screens.setSelection(selection.mapId, selection.modeId);
  screens.show('menu');

  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyF' && !event.repeat && !event.metaKey && !event.ctrlKey) stats.toggle();
    if (event.code === 'KeyM' && !event.repeat) screens.setMuted(audio.toggleMute());
    // Enter starts a round from any non-playing screen, so the game is reachable without a mouse.
    if (event.code === 'Enter' && !event.repeat) {
      void audio.unlock();
      orchestrator.dispatch('start');
    }
  });

  /*
   * Clicking the canvas during play re-acquires pointer lock if the browser dropped it. Screens
   * handle their own clicks and stop propagation, so this cannot fire from a menu.
   */
  canvas.addEventListener('click', () => {
    if (!touchCapable && orchestrator.current() === 'playing' && !pointerLock.isLocked()) {
      void pointerLock.request();
    }
  });

  document.addEventListener('visibilitychange', () => {
    audio.setSuspended(document.hidden);
    if (document.hidden && orchestrator.current() === 'playing') {
      orchestrator.dispatch('pause');
    }
  });

  /*
   * Rotating to portrait mid-round pauses rather than letting the player fight a layout that no
   * longer fits. The gate itself is shown by the overlay.
   */
  if (touch) {
    const onOrientation = () => {
      if (touch.isPortrait() && orchestrator.current() === 'playing') {
        orchestrator.dispatch('pause');
      }
    };
    window.addEventListener('resize', onOrientation);
    window.addEventListener('orientationchange', onOrientation);
  }

  const tracerTo = new Vector3();
  const impactAt = new Vector3();
  const soundAt = new Vector3();
  /** Tick the countdown was last advanced on, so one tick advances it exactly once. */
  let lastCountdownTick = -1;

  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = engine.getDeltaTime() / 1000;
    const frame = interpolate(host.snapshots(), now);
    const view = host.viewState();
    const state = orchestrator.current();

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
      audio.setListener(camera.position(), camera.forward());

      // Footsteps fire from the camera's own walk cycle, so the sound lands on the visible footfall
      // rather than on an independent timer that would drift out of sync with the bob.
      if (camera.consumeFootstep()) audio.footstep(camera.position(), true);

      enemies.update(frame, now, dt);
      hud.update(frame.discrete, now);
      hud.setSpread(view.spread);
      hud.handleEvents(host.drainHudEvents(), now);

      /*
       * Advance the countdown on simulation ticks, not wall-clock time, so the numbers cannot
       * finish before the round they are counting into actually starts.
       */
      if (state === 'countdown' && frame.tick !== lastCountdownTick) {
        lastCountdownTick = frame.tick;
        orchestrator.onSimulationTick(frame.tick);
        screens.setCountdown(orchestrator.countdownSeconds());
      }
    }

    weapon.update({
      now,
      dt,
      aiming: view.aiming,
      reloadProgress: view.reloadProgress,
      movingSpeed: view.speed,
    });

    /*
     * Reload sounds come from the animation's own stage transitions rather than a timer started at
     * the reload event, so both are driven by the same progress value and a click can never land on
     * motion that has not happened yet.
     */
    const stage = weapon.consumeStageChange();
    if (stage === 'release') audio.reloadRelease();
    else if (stage === 'extract') audio.reloadExtract();
    else if (stage === 'drop') audio.reloadDrop(camera.position());
    else if (stage === 'insert') audio.reloadInsert();
    else if (stage === 'seat') {
      audio.reloadSeat();
      // The charging handle follows shortly after seating, as the weapon is presented.
      setTimeout(() => audio.reloadPresent(), 170);
    }

    for (const event of host.drainVisualEvents()) {
      switch (event.kind) {
        case 'muzzle':
          weapon.onShot(now);
          camera.onShot();
          audio.playerShot(event.weaponIndex);
          casings.spawn(weapon.muzzleWorldPosition(), camera.forward(), now);
          break;
        case 'tracer':
          // Start at the muzzle, not the eye: a tracer from the centre of the screen looks like it
          // comes out of the player's face.
          tracerTo.set(event.to.x, event.to.y, event.to.z);
          tracers.spawn({ from: weapon.muzzleWorldPosition(), to: tracerTo }, now);
          break;
        case 'impact':
          impactAt.set(event.at.x, event.at.y, event.at.z);
          impacts.spawn({ at: impactAt, onBody: event.onBody }, now);
          audio.impact(impactAt, event.onBody);
          break;
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
          // Rumble on a hit, where the browser supports it. Best-effort and always optional.
          gamepad.vibrate(140, 0.6, 0.35);
          break;
        case 'kill':
          audio.kill();
          break;
        case 'headshot':
          audio.headshot();
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
        case 'reloadStart':
          // Stage transitions drive the sounds.
          break;
      }
    }

    tracers.update(now);
    impacts.update(now);
    casings.update(now, dt);

    arena.scene.render();
    stats.sample();
  });

  // Enemy meshes exist in the pool after the first wave; register them once they do.
  let shadowsRegistered = false;
  arena.scene.onAfterRenderObservable.add(() => {
    if (shadowsRegistered) return;
    const casters = enemies.shadowCasters();
    if (casters.length === 0) return;
    arena.addShadowCasters(casters);
    shadowsRegistered = true;
  });

  window.addEventListener('beforeunload', () => {
    // A closed page submits nothing partial (AC-ARM-006.5).
    recorder.discard();
    stopPump();
    host.dispose();
    pointerLock.dispose();
    adapter.dispose();
    gamepad.dispose();
    touch?.dispose();
    stopResize();
    screens.dispose();
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

start().catch((error: unknown) => {
  console.error('[rearena] failed to start', error);
  const hudRoot = document.getElementById('hud-root');
  if (hudRoot) {
    const message = error instanceof Error ? error.message : String(error);
    hudRoot.innerHTML = `<div class="screens" data-interactive="true"><section class="screen screen-loading" data-visible="true"><p class="screen-loading-text">Could not start. ${message}</p></section></div>`;
  }
});
