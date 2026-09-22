/**
 * Message contract between the main thread and the simulation worker.
 *
 * Versioned with SIM_VERSION: a browser holding a stale worker script after a deploy must fail
 * loudly rather than produce a run that the verifier will reject for reasons nobody can explain.
 *
 * Only plain data crosses the boundary. Nothing here carries a function, a Babylon object, or a
 * DOM node.
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

export const WORKER_PROTOCOL_VERSION = 2;

export type WorkerCommand =
  | {
      type: 'init';
      protocolVersion: number;
      config: MatchConfig;
      content: SimContent;
      /** Ticks of simulation the worker may catch up in one wake-up. Guards against stalls. */
      maxCatchUpTicks?: number;
    }
  /** Queue input for the next tick. One frame is consumed per tick, in arrival order. */
  | { type: 'input'; frame: InputFrame }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'dispose' };

export type WorkerEvent =
  | { type: 'ready'; protocolVersion: number; simVersion: number }
  | {
      type: 'snapshot';
      snapshot: RenderSnapshot;
      /** HUD events accumulated across the ticks in this batch. */
      hudEvents: HudEvent[];
      /** Current weapon spread as a fraction of its maximum, for the crosshair. */
      spread: number;
    }
  | { type: 'checkpoint'; checkpoint: StateCheckpoint }
  | { type: 'ended'; summary: RunSummary }
  | { type: 'error'; message: string };

export class WorkerProtocolError extends Error {}
