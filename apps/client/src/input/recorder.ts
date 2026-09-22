/**
 * RunRecorder: build the RunLog while the round is played.
 *
 * The log is what the verifier replays, so it has to hold exactly the frames the simulation
 * consumed, in order, plus the checkpoint hashes the simulation produced. Nothing is reconstructed
 * afterwards.
 *
 * Lifecycle matches the requirements: a round abandoned through restart or quit discards its log
 * (AC-ARM-006.4), and a closed page submits nothing partial (AC-ARM-006.5) because the log only
 * ever lives in memory until the round ends.
 */

import type {
  InputFrame,
  MatchConfig,
  RunLog,
  RunSummary,
  StateCheckpoint,
} from '@rearena/protocol';

function newRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for older browsers. Only needs to be unique per player, and the server also enforces
  // idempotency on this value.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined') crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
