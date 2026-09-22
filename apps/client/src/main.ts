/**
 * Client entry.
 *
 * Boots the rendering backend, builds the grey-box arena and starts the render loop. The
 * simulation worker bridge is WO-26, input is WO-30, and the React shell with menus and HUD is
 * WO-47 and WO-51; this file keeps the boot sequence in one readable place until then.
 */

import './styles.css';
import { bootEngine, observeResize } from './engine/bootstrap.js';
import { buildArena } from './render/arena.js';
import { FrameStats } from './render/frame-stats.js';

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');

function status(text: string): void {
  if (bootStatus) bootStatus.textContent = text;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (bootStatus) {
    bootStatus.dataset.error = 'true';
    bootStatus.textContent = `Could not start the renderer. ${message}`;
  }
  console.error(error);
}

async function start(): Promise<void> {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('canvas element is missing');
  }

  status('starting renderer');
  const { engine, backend, deviceClass, pixelRatio } = await bootEngine(canvas);
  console.info(`RE:Arena renderer: ${backend}, ${deviceClass}, pixel ratio ${pixelRatio}`);

  status('building arena');
  const arena = buildArena(engine);
  const stats = new FrameStats(engine, `${backend} ${deviceClass}`);

  const stopResize = observeResize(engine, canvas);

  let firstFrame = true;
  engine.runRenderLoop(() => {
    arena.scene.render();
    stats.sample();
    if (firstFrame) {
      firstFrame = false;
      if (boot) boot.dataset.hidden = 'true';
    }
  });

  // Focus loss pauses play once the simulation exists (WO-26). Until then it only stops drawing,
  // which saves battery on a backgrounded tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      engine.stopRenderLoop();
    } else {
      engine.runRenderLoop(() => {
        arena.scene.render();
        stats.sample();
      });
    }
  });

  // Temporary dev affordance: F toggles the frame-time overlay. Becomes a settings toggle in WO-25.
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyF' && !event.repeat && !event.metaKey && !event.ctrlKey) {
      stats.toggle();
    }
  });

  window.addEventListener('beforeunload', () => {
    stopResize();
    stats.dispose();
    arena.dispose();
    engine.dispose();
  });
}

start().catch(fail);
