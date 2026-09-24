/**
 * EngineBootstrap: pick a Babylon rendering backend and create the engine.
 *
 * WebGPU where the browser exposes it, WebGL2 everywhere else (ADR-003 in the Game Client
 * blueprint). Content is authored to the WebGL2 feature set so both paths render the same thing;
 * nothing here may affect gameplay, which lives in the simulation worker.
 */

import { Engine } from '@babylonjs/core/Engines/engine.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';

export type RenderBackend = 'webgpu' | 'webgl2';
export type DeviceClass = 'desktop' | 'tablet' | 'mobile' | 'unknown';

export interface BootResult {
  engine: AbstractEngine;
  backend: RenderBackend;
  deviceClass: DeviceClass;
  /** Device pixel ratio the engine was created with, before any dynamic scaling. */
  pixelRatio: number;
}

/**
 * Renderer strings that mean the browser is drawing on the CPU.
 *
 * SwiftShader is Chrome's software fallback, the Basic Render Driver is what Windows uses with no GPU driver installed, and
 * llvmpipe is the Linux equivalent. Any of them caps this game at a few frames per second whatever the tier.
 */
const SOFTWARE_RENDERER = /swiftshader|basic render|llvmpipe|softpipe|software/i;

function detectDeviceClass(): DeviceClass {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false;
  if (/iPad|Tablet/i.test(ua) || (coarse && Math.min(screen.width, screen.height) >= 600)) {
    return 'tablet';
  }
  if (/Mobi|Android|iPhone|iPod/i.test(ua) || coarse) return 'mobile';
  return 'desktop';
}

/**
 * Cap the pixel ratio on start-up. A phone at ratio 3 renders nine times the pixels of ratio 1
 * for no visible gain on a small screen, and it is the single largest early frame-time cost.
 * DynamicResolutionController (WO-25) tunes this further at run time.
 */
function initialPixelRatio(deviceClass: DeviceClass): number {
  const raw = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const cap = deviceClass === 'desktop' ? 2 : 1.5;
  return Math.min(raw, cap);
}

async function webGpuSupported(): Promise<boolean> {
  try {
    return await WebGPUEngine.IsSupportedAsync;
  } catch {
    return false;
  }
}

/**
 * Log which GPU the browser is really using, and warn loudly if it is none.
 *
 * The WebGL2 engine is created with failIfMajorPerformanceCaveat false so the game still starts without a GPU, but that also
 * meant it started silently on the CPU. A missing driver on a fresh install looked like a slow game rather than a setup problem.
 */
function reportRenderer(engine: Engine): void {
  let renderer = 'unknown';
  let vendor = 'unknown';
  try {
    const info = engine.getGlInfo();
    renderer = info.renderer || renderer;
    vendor = info.vendor || vendor;
  } catch {
    // Some browsers hide the renderer string. Not knowing is not an error.
  }
  console.info(`[rearena] gpu ${renderer} (${vendor})`);
  if (SOFTWARE_RENDERER.test(renderer)) {
    console.warn(
      '[rearena] The browser is rendering in software, not on your graphics card, so the game will run at a few frames per second on any setting. ' +
        'Install or update your graphics driver, turn on "Use graphics acceleration when available" in the browser settings, restart the browser, ' +
        'and check chrome://gpu shows hardware acceleration.',
    );
  }
}

export async function bootEngine(canvas: HTMLCanvasElement): Promise<BootResult> {
  const deviceClass = detectDeviceClass();
  const pixelRatio = initialPixelRatio(deviceClass);

  if (await webGpuSupported()) {
    try {
      const engine = new WebGPUEngine(canvas, {
        antialias: true,
        adaptToDeviceRatio: false,
        powerPreference: 'high-performance',
      });
      await engine.initAsync();
      engine.setHardwareScalingLevel(1 / pixelRatio);
      return { engine, backend: 'webgpu', deviceClass, pixelRatio };
    } catch (error) {
      // Fall through to WebGL2. Some drivers report support and then fail to initialise.
      console.warn('WebGPU initialisation failed, falling back to WebGL2', error);
    }
  }

  const engine = new Engine(
    canvas,
    true,
    {
      preserveDrawingBuffer: false,
      stencil: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    },
    false,
  );
  engine.setHardwareScalingLevel(1 / pixelRatio);
  reportRenderer(engine);
  return { engine, backend: 'webgl2', deviceClass, pixelRatio };
}

/** Keep the drawing buffer matched to the element size. Returns a disposer. */
export function observeResize(engine: AbstractEngine, canvas: HTMLCanvasElement): () => void {
  const onResize = () => engine.resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(onResize);
    observer.observe(canvas);
  }
  return () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    observer?.disconnect();
  };
}
