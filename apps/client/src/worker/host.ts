/**
 * SimulationHost: the main thread's view of the simulation worker.
 *
 * Owns the worker's lifecycle and keeps the two most recent snapshots so the renderer can
 * interpolate between them (ADR-001 in the Game Client blueprint). Nothing here computes
 * gameplay; it moves messages and buffers state.
 */

import type {
  InputFrame,
  MatchConfig,
  RenderSnapshot,
  RunSummary,
  StateCheckpoint,
} from '@rearena/protocol';
import type { SimContent } from '@rearena/sim';
import {
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol.js';

export interface SnapshotPair {
  previous: RenderSnapshot | null;
  latest: RenderSnapshot | null;
  /** Timestamp the latest snapshot arrived, from performance.now(). Display pacing only. */
  latestAt: number;
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
  }
}
