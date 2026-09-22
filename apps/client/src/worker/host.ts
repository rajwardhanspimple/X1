/**
 * SimulationHost: the main thread's view of the simulation worker.
 *
 * Owns the worker's lifecycle, keeps the two most recent snapshots so the renderer can interpolate
 * between them, and buffers the events each snapshot carried so the main thread can drain them once
 * per frame. Nothing here computes gameplay; it moves messages and buffers state.
 */

import type {
  InputFrame,
  MatchConfig,
  RenderSnapshot,
  RunSummary,
  StateCheckpoint,
} from '@rearena/protocol';
import type { SimContent } from '@rearena/sim';
import type { HudEvent } from '../hud/hud.js';
import {
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  type VisualEvent,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol.js';

export interface SnapshotPair {
  previous: RenderSnapshot | null;
  latest: RenderSnapshot | null;
  /** Timestamp the latest snapshot arrived, from performance.now(). Display pacing only. */
  latestAt: number;
}

/** Presentation inputs the view model and camera need, none of which affect the simulation. */
export interface ViewState {
  spread: number;
  speed: number;
  /** 0 to 1 through a reload, 0 when not reloading. Drives the staged reload animation. */
  reloadProgress: number;
  aiming: boolean;
  grounded: boolean;
}

export interface SimulationHostCallbacks {
  onCheckpoint?(checkpoint: StateCheckpoint): void;
  onEnded?(summary: RunSummary): void;
  onError?(message: string): void;
}

export class SimulationHost {
  private worker: Worker | null = null;
  private ready = false;
  private readonly pair: SnapshotPair = { previous: null, latest: null, latestAt: 0 };
  private hudEvents: HudEvent[] = [];
  private visualEvents: VisualEvent[] = [];
  private view: ViewState = {
    spread: 0,
    speed: 0,
    reloadProgress: 0,
    aiming: false,
    grounded: true,
  };

  constructor(private readonly callbacks: SimulationHostCallbacks = {}) {}

  async start(config: MatchConfig, content: SimContent): Promise<void> {
    this.dispose();
    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), {
      type: 'module',
      name: 'rearena-sim',
    });
    this.worker = worker;

    const readyPromise = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerEvent>) => {
        const message = event.data;
        if (message.type === 'ready') {
          if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
            reject(
              new WorkerProtocolError(
                `worker protocol ${message.protocolVersion} does not match page ${WORKER_PROTOCOL_VERSION}`,
              ),
            );
            return;
          }
          this.ready = true;
          resolve();
        } else if (message.type === 'error' && !this.ready) {
          reject(new Error(message.message));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
    });

    worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) =>
      this.handle(event.data),
    );

    this.send({ type: 'init', protocolVersion: WORKER_PROTOCOL_VERSION, config, content });
    await readyPromise;
    this.send({ type: 'start' });
  }

  private handle(message: WorkerEvent): void {
    switch (message.type) {
      case 'snapshot': {
        this.pair.previous = this.pair.latest;
        this.pair.latest = message.snapshot;
        this.pair.latestAt = performance.now();
        if (message.hudEvents.length > 0) this.hudEvents.push(...message.hudEvents);
        if (message.visualEvents.length > 0) this.visualEvents.push(...message.visualEvents);
        this.view = {
          spread: message.spread,
          speed: message.speed,
          reloadProgress: message.reloadProgress,
          aiming: message.aiming,
          grounded: message.grounded,
        };
        return;
      }
      case 'checkpoint':
        this.callbacks.onCheckpoint?.(message.checkpoint);
        return;
      case 'ended':
        this.callbacks.onEnded?.(message.summary);
        return;
      case 'error':
        this.callbacks.onError?.(message.message);
        return;
      case 'ready':
        return;
    }
  }

  private send(command: WorkerCommand): void {
    this.worker?.postMessage(command);
  }

  sendInput(frame: InputFrame): void {
    if (!this.ready) return;
    this.send({ type: 'input', frame });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  resume(): void {
    this.send({ type: 'resume' });
  }

  snapshots(): SnapshotPair {
    return this.pair;
  }

  /** Take and clear the buffered HUD events. Called once per rendered frame. */
  drainHudEvents(): HudEvent[] {
    if (this.hudEvents.length === 0) return [];
    const events = this.hudEvents;
    this.hudEvents = [];
    return events;
  }

  /** Take and clear the buffered visual and audio events. Called once per rendered frame. */
  drainVisualEvents(): VisualEvent[] {
    if (this.visualEvents.length === 0) return [];
    const events = this.visualEvents;
    this.visualEvents = [];
    return events;
  }

  viewState(): ViewState {
    return this.view;
  }

  /** Tick the simulation has reached, or 0 before the first snapshot. */
  currentTick(): number {
    return this.pair.latest?.tick ?? 0;
  }

  dispose(): void {
    if (!this.worker) return;
    this.send({ type: 'dispose' });
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.pair.previous = null;
    this.pair.latest = null;
    this.pair.latestAt = 0;
    this.hudEvents = [];
    this.visualEvents = [];
    this.view = { spread: 0, speed: 0, reloadProgress: 0, aiming: false, grounded: true };
  }
}
