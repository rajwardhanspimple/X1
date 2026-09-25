/**
 * Camera rig: the presentation layer on top of the simulated aim.
 *
 * The simulation decides where the player is looking. Everything here is added on top for feel:
 * walk bob, a dip on landing, a kick per shot, and a narrower field of view while aiming. This is
 * what makes a first-person game feel physical instead of like a floating camera.
 *
 * ## Why there is no shake
 *
 * There used to be camera shake on damage. It moved the crosshair, which in a shooter is paying for
 * feedback with control: under sustained fire the view would not hold still, and because the bullets
 * come from the simulation's own aim rather than from the camera, the sight picture was also lying
 * about where the next shot would go.
 *
 * Damage is now communicated by sound, gamepad rumble and a directional HUD edge. All three leave the
 * crosshair where the player put it. The rule this generalises to: feedback may not move the aim
 * point. Bob and the landing dip are exempt because they read as the player's own motion rather than
 * as the view being grabbed.
 *
 * Critically, none of it feeds back into the simulation. The aim used for a bullet is the
 * simulation's own yaw and pitch, so what the verifier replays is unaffected by any of this motion.
 * That is why the offsets are applied to the camera transform and never to the input stream.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';

const BASE_FOV = 1.25;
const ADS_FOV = 0.85;

/** Bob amplitude at full sprint, in world units. Small: too much reads as seasickness. */
const BOB_VERTICAL = 0.045;
const BOB_HORIZONTAL = 0.03;
const BOB_ROLL = 0.006;

const LAND_DIP_MAX = 0.16;
const SHOT_KICK_PITCH = 0.0045;
const SHOT_KICK_YAW = 0.002;

/** Player Down: the eye drops toward the floor and the view rolls onto its side. */
const DOWN_DROP_MAX = 0.9;
const DOWN_TILT_MAX = 0.35;
/** Seconds the fall takes. Short, so it reads as collapsing rather than lying down. */
const DOWN_FALL_SECONDS = 0.6;

export interface CameraInput {
  /** Eye position from the simulation snapshot. */
  x: number;
  y: number;
  z: number;
  /** Yaw and pitch in turns, already including weapon recoil. */
  yaw: number;
  pitch: number;
  /** Horizontal speed in units per second. */
  speed: number;
  grounded: boolean;
  aiming: boolean;
  /** Ticks remaining in the Player Down state; 0 or absent when alive. */
  downTicks?: number;
  dt: number;
}

/** Smoothstep, so the fall eases in and out. */
function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export class CameraRig {
  private bobPhase = 0;
  private bobAmount = 0;
  private landDip = 0;
  private kickPitch = 0;
  private kickYaw = 0;
  private fov = BASE_FOV;
  private wasGrounded = true;
  private lastY = 0;
  private fallSpeed = 0;
  /** Seconds since the player went down, or 0 while alive. */
  private downElapsed = 0;

  private readonly eye = new Vector3();
  private readonly target = new Vector3();

  constructor(private readonly camera: FreeCamera) {
    camera.fov = BASE_FOV;
  }

  /** A shot was fired: kick the view up and slightly sideways. */
  onShot(): void {
    this.kickPitch += SHOT_KICK_PITCH;
    // Alternate the horizontal direction so sustained fire wanders rather than drifting one way.
    this.kickYaw += (Math.random() * 2 - 1) * SHOT_KICK_YAW;
  }

  /**
   * Deliberately a no-op.
   *
   * It used to add camera shake. See the header: moving the aim point to communicate a hit pays for
   * feedback with control, so the cue moved to sound, rumble and the HUD. The method stays because
   * main calls it, and keeping the signature means the call site says what happened rather than being
   * deleted quietly.
   */
  onDamage(_intensity = 1): void {}

  /** Deliberately a no-op, for the same reason. */
  onImpulse(_intensity: number): void {}

  /** Clear transient presentation state when a round or map is restarted. */
  reset(): void {
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landDip = 0;
    this.kickPitch = 0;
    this.kickYaw = 0;
    this.fov = BASE_FOV;
    this.wasGrounded = true;
    this.lastY = this.camera.position.y;
    this.fallSpeed = 0;
    this.downElapsed = 0;
    this.lastBobPhase = 0;
    this.eye.copyFrom(this.camera.position);
    this.target.set(this.eye.x, this.eye.y, this.eye.z + 1);
    this.camera.fov = BASE_FOV;
    this.camera.rotation.z = 0;
  }

  update(input: CameraInput): void {
    const dt = Math.min(0.05, Math.max(0.001, input.dt));
    const ease = (current: number, target: number, rate: number): number =>
      current + (target - current) * Math.min(1, dt * rate);

    // Track fall speed so a landing dip can scale with it: dropping off a pillar should hit harder
    // than stepping off a kerb.
    const dy = input.y - this.lastY;
    this.lastY = input.y;
    if (!input.grounded) {
      this.fallSpeed = Math.max(0, -dy / dt);
    }

    if (input.grounded && !this.wasGrounded) {
      this.landDip = Math.min(LAND_DIP_MAX, this.fallSpeed * 0.012);
      this.fallSpeed = 0;
    }
    this.wasGrounded = input.grounded;

    // Bob follows speed and only while grounded: bobbing mid-jump looks wrong.
    const targetBob = input.grounded ? Math.min(1, input.speed / 10.5) : 0;
    this.bobAmount = ease(this.bobAmount, targetBob, 7);
    this.bobPhase += dt * (6 + input.speed * 1.15);

    this.landDip = ease(this.landDip, 0, 9);
    this.kickPitch = ease(this.kickPitch, 0, 13);
    this.kickYaw = ease(this.kickYaw, 0, 13);

    // Aiming narrows the field of view. Eased, so it reads as a zoom rather than a cut.
    this.fov = ease(this.fov, input.aiming ? ADS_FOV : BASE_FOV, 12);
    this.camera.fov = this.fov;

    // Bob is damped while aiming: a steady sight picture is the point of aiming.
    const bobScale = this.bobAmount * (input.aiming ? 0.25 : 1);
    // Vertical bob runs at twice the horizontal rate, which is what a two-step gait produces.
    const bobY = Math.sin(this.bobPhase * 2) * BOB_VERTICAL * bobScale;
    const bobX = Math.sin(this.bobPhase) * BOB_HORIZONTAL * bobScale;
    const bobRoll = Math.sin(this.bobPhase) * BOB_ROLL * bobScale;

    // Only the shot kick perturbs aim, and only briefly: it is recoil, which is the weapon acting.
    const yawTurns = input.yaw + this.kickYaw;
    const pitchTurns = input.pitch + this.kickPitch;

    const yawRad = yawTurns * Math.PI * 2;
    const pitchRad = pitchTurns * Math.PI * 2;

    /*
     * Player Down. Driven by time since going down, not by ticks remaining: remaining ticks count
     * DOWN, so a collapse keyed on them starts on the floor and rises as the respawn approaches.
     * Presentation only; the simulation owns the down timer.
     */
    const down = (input.downTicks ?? 0) > 0;
    this.downElapsed = down ? this.downElapsed + dt : 0;
    const fall = down ? smooth(this.downElapsed / DOWN_FALL_SECONDS) : 0;

    this.eye.set(
      input.x + bobX,
      input.y + bobY - this.landDip - DOWN_DROP_MAX * fall,
      input.z,
    );
    this.target.set(
      this.eye.x + Math.sin(yawRad) * Math.cos(pitchRad),
      this.eye.y + Math.sin(pitchRad),
      this.eye.z + Math.cos(yawRad) * Math.cos(pitchRad),
    );

    if (fall > 0) this.camera.fov = this.fov * (1 - fall * 0.1);

    this.camera.position.copyFrom(this.eye);
    this.camera.setTarget(this.target);
    // Roll has to be applied after setTarget, which resets rotation.
    this.camera.rotation.z = fall > 0 ? DOWN_TILT_MAX * fall : bobRoll;
  }

  /** Forward vector, for the audio listener. */
  forward(): Vector3 {
    return this.target.subtract(this.eye).normalize();
  }

  position(): Vector3 {
    return this.eye;
  }

  /** True when the walk cycle passes a footfall, so a footstep sound can be triggered. */
  consumeFootstep(): boolean {
    // A footfall is when the vertical bob reaches its low point. Track sign changes of the
    // derivative rather than the value, so the cadence matches the visible bob exactly.
    const phase = (this.bobPhase * 2) % (Math.PI * 2);
    const stepping = phase < this.lastBobPhase;
    this.lastBobPhase = phase;
    return stepping && this.bobAmount > 0.25;
  }

  private lastBobPhase = 0;
}
