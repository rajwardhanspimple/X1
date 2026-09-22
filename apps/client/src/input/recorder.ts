/**
 * RunRecorder: build the RunLog while the round is played.
 *
 * The log is what the verifier replays, so it has to hold exactly the frames the simulation consumed,
 * in order, plus the checkpoint hashes the simulation produced. Nothing is reconstructed afterwards.
 *
 * Lifecycle matches the requirements: a round abandoned through restart or quit discards its log
 * (AC-ARM-006.4), and a closed page submits nothing partial (AC-ARM-006.5) because the log only ever
 * lives in memory until the round ends.
 */

import type {
  InputFrame,
  MatchConfig,
  RunLog,
  RunSummary,
  StateCheckpoint,
} from '@rearena/protocol';

/**
 * A unique id for this run.
 *
 * The guard is against a non-browser or insecure context rather than against a browser that lacks
 * crypto; it is written against globalThis because the DOM types declare `crypto` as always present,
 * so `typeof crypto !== 'undefined'` narrows it to `never` in the negative branch and the fallback
 * becomes unreachable as far as the compiler is concerned.
 */
function newRunId(): string {
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;

  if (webcrypto?.randomUUID) return webcrypto.randomUUID();

  if (webcrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    webcrypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /*
   * Last resort. Only needs to be unique per player, and the server also enforces idempotency on this
   * value, so a collision is rejected rather than silently overwriting a run.
   */
  return `${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

export class RunRecorder {
  private clientRunId = '';
  private config: MatchConfig | null = null;
  private frames: InputFrame[] = [];
  private checkpoints: StateCheckpoint[] = [];
  private recording = false;

  constructor(private readonly clientVersion: string) {}

  begin(config: MatchConfig): string {
    this.clientRunId = newRunId();
    this.config = config;
    this.frames = [];
    this.checkpoints = [];
    this.recording = true;
    return this.clientRunId;
  }

  isRecording(): boolean {
    return this.recording;
  }

  appendFrame(frame: InputFrame): void {
    if (!this.recording) return;
    // Copy: the router reuses its frame object between ticks.
    this.frames.push({ ...frame });
  }

  appendCheckpoint(checkpoint: StateCheckpoint): void {
    if (!this.recording) return;
    this.checkpoints.push({ ...checkpoint });
  }

  /** Called on restart, quit or any abandoned round. Nothing is submitted. */
  discard(): void {
    this.recording = false;
    this.config = null;
    this.frames = [];
    this.checkpoints = [];
    this.clientRunId = '';
  }

  /** Seal the log at round end. Returns null if there was nothing being recorded. */
  finish(summary: RunSummary): RunLog | null {
    if (!this.recording || !this.config) return null;
    this.recording = false;
    const log: RunLog = {
      clientRunId: this.clientRunId,
      matchConfig: this.config,
      clientVersion: this.clientVersion,
      frames: this.frames,
      checkpoints: this.checkpoints,
      summary,
    };
    return log;
  }

  /** Diagnostics for the HUD and the submission payload size estimate. */
  stats(): { frames: number; checkpoints: number } {
    return { frames: this.frames.length, checkpoints: this.checkpoints.length };
  }
}
