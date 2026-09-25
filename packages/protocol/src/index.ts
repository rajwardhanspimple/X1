/**
 * Shared wire and domain types for RE:Arena.
 *
 * Nothing here depends on the DOM, Node, or Babylon. The client, the sim package and the
 * verify-run Edge Function all import these shapes.
 */

/** Simulation ticks per second. The tick counter is the only clock in the simulation. */
export const TICK_HZ = 60;

/** Checkpoint hash cadence, in ticks. */
export const HASH_INTERVAL_TICKS = 60;

/** A Q16.16 fixed-point value carried as a JavaScript integer. See packages/sim math/fixed. */
export type Fx = number;

/** Button bitmask carried in InputFrame.buttons. */
export const Buttons = {
  None: 0,
  Fire: 1 << 0,
  Aim: 1 << 1,
  Reload: 1 << 2,
  Jump: 1 << 3,
  Crouch: 1 << 4,
  Sprint: 1 << 5,
  Swap: 1 << 6,
  /** Asks for a slide. The client sets it when crouch and sprint are held; the sim decides. */
  Slide: 1 << 7,
} as const;
export type ButtonMask = number;

/** Flags that change how input is interpreted but must be recorded to stay verifiable. */
export const InputFlags = {
  None: 0,
  /** Gamepad aim assist was active for this frame. Assist is computed inside the sim. */
  AimAssist: 1 << 0,
} as const;
export type InputFlagMask = number;

/**
 * Exactly one frame is consumed per tick. An idle tick is an explicit frame with zero
 * movement, zero look delta and no buttons; the client never skips or merges frames.
 *
 * move and look are Q16.16. look values are per-tick deltas in turns (65536 = one full turn),
 * already scaled by the player's sensitivity, so the log is device independent.
 */
export interface InputFrame {
  tick: number;
  moveX: Fx;
  moveY: Fx;
  lookYaw: Fx;
  lookPitch: Fx;
  buttons: ButtonMask;
  flags: InputFlagMask;
}

export function emptyInputFrame(tick: number): InputFrame {
  return { tick, moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0, buttons: 0, flags: 0 };
}

/** Weapon slots a player carries. */
export const WeaponSlot = { Primary: 0, Secondary: 1 } as const;

export interface Loadout {
  primaryWeapon: string;
  secondaryWeapon: string;
  perks: string[];
}

/**
 * Everything needed to reproduce a round. Two runs with the same MatchConfig, the same
 * SimContent (identified by contentHash) and the same InputFrame sequence produce the same
 * StateHash at every checkpoint and the same RunSummary.
 *
 * seed is an unsigned 32-bit integer.
 */
export interface MatchConfig {
  mapId: string;
  modeId: string;
  seed: number;
  simVersion: number;
  contentHash: string;
  loadout: Loadout;
}

/** 16 lowercase hex characters: two xxHash32 passes over the canonical state bytes. */
export type StateHash = string;

export interface StateCheckpoint {
  tick: number;
  hash: StateHash;
}

/** Render-facing pose. Floats, produced only for display; never fed back into the sim. */
export interface PoseView {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/**
 * An enemy as the renderer needs to see it.
 *
 * Archetype, stance and telegraph state are here because the renderer cannot derive them: it was
 * previously guessing archetype from the entity id, which drew rushers with a heavy's colour and
 * size. Everything on this type is presentation-only and never read back by the simulation.
 */
export interface EnemyView extends PoseView {
  /** Index into the archetype table: 0 rusher, 1 rifleman, 2 heavy. */
  archetype: number;
  /** Brain state index: 0 idle, 1 advance, 2 engage, 3 retreat. */
  brain: number;
  /** True while winding up a shot, so the figure can telegraph it. */
  telegraphing: boolean;
  /** Remaining health as a fraction of the archetype maximum, for damage tinting. */
  healthFraction: number;
}

/** One frame of state for the renderer. The main thread interpolates between snapshots. */
export interface RenderSnapshot {
  tick: number;
  player: PoseView;
  playerHealth: number;
  playerDownTicks: number;
  /**
   * True while the player is in a slide. Optional for the same reason as aimAssistTargetId below.
   * Presentation only: the camera leans and the view widens.
   */
  playerSliding?: boolean;
  weaponSlot: number;
  ammo: number;
  reserve: number;
  enemies: EnemyView[];
  projectiles: PoseView[];
  score: number;
  streak: number;
  multiplier: number;
  ticksRemaining: number;
  /**
   * Enemy id that gamepad aim assist is holding this tick, or 0 for none.
   *
   * Optional so a snapshot from a worker built before this field existed still satisfies the type,
   * which keeps the worker protocol version independent of the sim version. Presentation only: the
   * HUD marks the target, and nothing here is ever read back by the simulation.
   */
  aimAssistTargetId?: number;
}

export interface RunSummary {
  score: number;
  kills: number;
  deaths: number;
  /** Accuracy in basis points (10000 = 100%). Integer, so it hashes and compares exactly. */
  accuracyBp: number;
  shotsFired: number;
  shotsHit: number;
  medals: string[];
  durationTicks: number;
  finalHash: StateHash;
}

/** The recording submitted for verification. */
export interface RunLog {
  clientRunId: string;
  matchConfig: MatchConfig;
  clientVersion: string;
  frames: InputFrame[];
  checkpoints: StateCheckpoint[];
  summary: RunSummary;
}

export interface ReplayResult {
  summary: RunSummary;
  checkpoints: StateCheckpoint[];
  /** First tick whose replayed hash differs from the expected one, or null when all matched. */
  mismatchTick: number | null;
}

/**
 * One bounded step of a resumable replay. The verify-run Edge Function persists `state`
 * on the verification_jobs row between invocations to stay under the CPU cap.
 */
export interface SliceResult {
  /** Canonical SimState bytes to resume from, or null once the log is exhausted. */
  state: Uint8Array | null;
  cursorTick: number;
  checkpoints: StateCheckpoint[];
  mismatchTick: number | null;
  /** Present only on the final slice. */
  summary: RunSummary | null;
  done: boolean;
}

export type RejectionReason =
  'replay_mismatch' | 'unsupported_version' | 'malformed_log' | 'duplicate' | 'verifier_error';

export interface VerificationOutcome {
  verified: boolean;
  reason?: RejectionReason;
  firstMismatchTick?: number;
  verifiedScore?: number;
}
