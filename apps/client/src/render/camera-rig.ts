import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { getAccessibilitySettings, subscribeAccessibility } from './accessibility.js';
import { playerPresentation } from './player-presentation.js';

const BASE_FOV = 1.25;
const ADS_FOV = 0.85;
const BOB_VERTICAL = 0.045;
const BOB_HORIZONTAL = 0.03;
const BOB_ROLL = 0.006;
const LAND_DIP_MAX = 0.16;
const SHOT_KICK_PITCH = 0.0045;
const SHOT_KICK_YAW = 0.002;
const SLIDE_DIP = 0.12;
const SLIDE_ROLL = 0.05;
const SLIDE_FOV = 0.08;
const DOWN_DROP_MAX = 0.9;
const DOWN_TILT_MAX = 0.35;
const DOWN_FALL_SECONDS = 0.6;

export interface CameraInput {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  speed: number;
  grounded: boolean;
  aiming: boolean;
  downTicks?: number;
  sliding?: boolean;
  dt: number;
}

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
  private slideBlend = 0;
  private downElapsed = 0;
  private lastBobPhase = 0;
  private reduceMotion = getAccessibilitySettings().reduceMotion;
  private readonly eye = new Vector3();
  private readonly target = new Vector3();
  private readonly unsubscribeAccessibility: () => void;

  constructor(private readonly camera: FreeCamera) {
    camera.fov = BASE_FOV;
    this.unsubscribeAccessibility = subscribeAccessibility((settings) => {
      this.reduceMotion = settings.reduceMotion;
    });
  }

  onShot(): void {
    if (!this.reduceMotion) {
      this.kickPitch += SHOT_KICK_PITCH;
      this.kickYaw += (Math.random() * 2 - 1) * SHOT_KICK_YAW;
    }
  }

  onDamage(_intensity = 1): void {}
  onImpulse(_intensity: number): void {}

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
    this.slideBlend = 0;
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
    const downTicks = input.downTicks ?? playerPresentation.downTicks;
    const sliding = input.sliding ?? playerPresentation.sliding;
    const motionScale = this.reduceMotion ? 0 : 1;
    const dy = input.y - this.lastY;
    this.lastY = input.y;
    if (!input.grounded) this.fallSpeed = Math.max(0, -dy / dt);
    if (input.grounded && !this.wasGrounded) {
      this.landDip = Math.min(LAND_DIP_MAX, this.fallSpeed * 0.012) * motionScale;
      this.fallSpeed = 0;
    }
    this.wasGrounded = input.grounded;
    this.slideBlend = ease(this.slideBlend, sliding ? 1 : 0, sliding ? 14 : 8);
    const targetBob =
      input.grounded && !sliding ? Math.min(1, input.speed / 10.5) * motionScale : 0;
    this.bobAmount = ease(this.bobAmount, targetBob, 7);
    this.bobPhase += dt * (6 + input.speed * 1.15);
    this.landDip = ease(this.landDip, 0, 9);
    this.kickPitch = ease(this.kickPitch, 0, 13);
    this.kickYaw = ease(this.kickYaw, 0, 13);
    this.fov = ease(this.fov, input.aiming ? ADS_FOV : BASE_FOV, 12);
    const bobScale = this.bobAmount * (input.aiming ? 0.25 : 1);
    const bobY = Math.sin(this.bobPhase * 2) * BOB_VERTICAL * bobScale;
    const bobX = Math.sin(this.bobPhase) * BOB_HORIZONTAL * bobScale;
    const bobRoll = Math.sin(this.bobPhase) * BOB_ROLL * bobScale;
    const yawRad = (input.yaw + this.kickYaw * motionScale) * Math.PI * 2;
    const pitchRad = (input.pitch + this.kickPitch * motionScale) * Math.PI * 2;
    const down = downTicks > 0;
    this.downElapsed = down ? this.downElapsed + dt : 0;
    const fall = down ? smooth(this.downElapsed / DOWN_FALL_SECONDS) * motionScale : 0;
    this.eye.set(
      input.x + bobX,
      input.y +
        bobY -
        this.landDip -
        SLIDE_DIP * this.slideBlend * motionScale -
        DOWN_DROP_MAX * fall,
      input.z,
    );
    this.target.set(
      this.eye.x + Math.sin(yawRad) * Math.cos(pitchRad),
      this.eye.y + Math.sin(pitchRad),
      this.eye.z + Math.cos(yawRad) * Math.cos(pitchRad),
    );
    this.camera.fov = (this.fov + SLIDE_FOV * this.slideBlend * motionScale) * (1 - fall * 0.1);
    this.camera.position.copyFrom(this.eye);
    this.camera.setTarget(this.target);
    this.camera.rotation.z =
      fall > 0
        ? DOWN_TILT_MAX * fall
        : bobRoll * (1 - this.slideBlend) + SLIDE_ROLL * this.slideBlend * motionScale;
  }

  forward(): Vector3 {
    return this.target.subtract(this.eye).normalize();
  }
  position(): Vector3 {
    return this.eye;
  }
  consumeFootstep(): boolean {
    const phase = (this.bobPhase * 2) % (Math.PI * 2);
    const stepping = phase < this.lastBobPhase;
    this.lastBobPhase = phase;
    return stepping && this.bobAmount > 0.25;
  }

  dispose(): void {
    this.unsubscribeAccessibility();
  }
}
