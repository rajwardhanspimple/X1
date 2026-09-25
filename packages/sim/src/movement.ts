/**
 * PlayerController: how the player moves.
 *
 * All values are Q16.16 per tick or per tick squared, which is why they look small: at 60 Hz a
 * walk speed of 7 units per second is 7/60 per tick. Naming keeps the per-second figure in a
 * comment so the numbers are reviewable.
 *
 * Velocity accelerates toward a target rather than being assigned directly. Assigning it makes a
 * player feel like a cursor; accelerating gives weight and makes strafing and counter-strafing
 * feel deliberate. Every constant here affects the outcome, so changing one is a simVersion bump.
 *
 * ## Slide
 *
 * A slide is a short burst at crouch height. It starts on the tick the Slide bit arrives, but only
 * while grounded, moving and faster than walking, so in practice it comes out of a sprint. It then
 * decays on its own and ends after SLIDE_TICKS, or earlier on a wall, a jump or leaving the ground.
 *
 * The speed gate is also what stops chaining. A slide ends below walking speed, so holding the bit
 * cannot start the next one; the player has to sprint back up first. That keeps the rule inside the
 * simulation instead of trusting the client to send the bit on one tick only.
 */

import { Buttons, type InputFrame } from '@rearena/protocol';
import { isGrounded, resolveMove, type BodyShape, type CollisionWorld } from './collision.js';
import * as fx from './math/fixed.js';
import type { PlayerState, Vec3Fx } from './state.js';

// --- Tuning ---------------------------------------------------------------------------------

/** 7.0 units per second. */
const WALK_SPEED = fx.fromRatio(7 * 1000, 60 * 1000);
/** 10.5 units per second. */
const SPRINT_SPEED = fx.fromRatio(105 * 100, 60 * 1000);
/** 3.4 units per second. */
const CROUCH_SPEED = fx.fromRatio(34 * 100, 60 * 1000);

/** Ground acceleration, reaching walk speed in about six ticks. */
const GROUND_ACCEL = fx.fromRatio(WALK_SPEED, 6) | 0;
/** Air acceleration is deliberately weak: you commit to a jump. */
const AIR_ACCEL = fx.fromRatio(WALK_SPEED, 22) | 0;
/** Ground friction applied when there is no input, as a fraction retained per tick. */
const GROUND_FRICTION = fx.fromRatio(78, 100);
/** Air drag, near zero so arcs stay predictable. */
const AIR_FRICTION = fx.fromRatio(995, 1000);

/** Gravity, about 22 units per second squared. */
const GRAVITY = fx.fromRatio(22 * 1000, 60 * 60 * 1000) | 0;
/** Initial jump velocity: clears roughly 1.1 units, so low cover needs a jump or a step-up. */
const JUMP_VELOCITY = fx.fromRatio(78 * 100, 60 * 1000);
/** Terminal fall speed, so a long drop cannot tunnel through a floor in one tick. */
const MAX_FALL_SPEED = fx.fromRatio(45 * 1000, 60 * 1000);

/** 13 units per second at the start of a slide: faster than a sprint, so it is worth doing. */
const SLIDE_SPEED = fx.fromRatio(13 * 1000, 60 * 1000);
/** Speed kept per tick while sliding. After 30 ticks about 40% is left, below walking speed. */
const SLIDE_FRICTION = fx.fromRatio(97, 100);
/** Steering while sliding, a quarter of ground acceleration: a slide is committed, not free. */
const SLIDE_STEER = (GROUND_ACCEL / 4) | 0;
/** A slide needs more than walking speed, so it comes out of a sprint and cannot be chained. */
const SLIDE_MIN_SPEED = WALK_SPEED;

const STAND_HEIGHT = fx.fromRatio(180, 100);
const CROUCH_HEIGHT = fx.fromRatio(120, 100);
const BODY_HALF_WIDTH = fx.fromRatio(40, 100);

/** Eye height above the foot position, for the camera and for hitscan origins. */
export const EYE_OFFSET_STAND = fx.fromRatio(165, 100);
export const EYE_OFFSET_CROUCH = fx.fromRatio(105, 100);

/** Ticks after leaving a ledge during which a jump still works. Forgiving, not exploitable. */
const COYOTE_TICKS = 6;
/** Ticks a jump press is remembered while airborne, so an early press still fires on landing. */
const JUMP_BUFFER_TICKS = 6;
/** Ticks a slide lasts at most: half a second. Short enough to be a dodge, long enough to cover ground. */
export const SLIDE_TICKS = 30;

export function bodyShape(crouching: boolean): BodyShape {
  return { halfWidth: BODY_HALF_WIDTH, height: crouching ? CROUCH_HEIGHT : STAND_HEIGHT };
}

export function eyeOffset(crouching: boolean): fx.Fx {
  return crouching ? EYE_OFFSET_CROUCH : EYE_OFFSET_STAND;
}

/**
 * Extra per-player movement state. Kept on PlayerState as plain integers so it serialises with
 * everything else; these are the field names used there.
 */
export interface MovementFields {
  coyoteTicks: number;
  jumpBufferTicks: number;
  /** Ticks left in the current slide; 0 when not sliding. */
  slideTicks: number;
}

function targetSpeed(sprinting: boolean, crouching: boolean): fx.Fx {
  if (crouching) return CROUCH_SPEED;
  return sprinting ? SPRINT_SPEED : WALK_SPEED;
}

/**
 * Rotate the input axes into world space using the player's yaw.
 *
 * moveY is forward, moveX is right. Yaw is in turns, and the sine and cosine come from FixedMath,
 * never from Math.sin, so the result is identical on every engine.
 */
function worldDirection(yaw: fx.Fx, moveX: fx.Fx, moveY: fx.Fx): { x: fx.Fx; z: fx.Fx } {
  const s = fx.sinTurns(yaw);
  const c = fx.cosTurns(yaw);
  // Forward is (sin, cos); right is (cos, -sin).
  return {
    x: (fx.mul(moveY, s) + fx.mul(moveX, c)) | 0,
    z: (fx.mul(moveY, c) - fx.mul(moveX, s)) | 0,
  };
}

/** Accelerate one velocity component toward a target, never overshooting it. */
function approach(current: fx.Fx, target: fx.Fx, accel: fx.Fx): fx.Fx {
  const diff = (target - current) | 0;
  if (diff === 0) return current;
  if (fx.abs(diff) <= accel) return target;
  return (current + (diff > 0 ? accel : -accel)) | 0;
}

/**
 * Advance the player one tick.
 *
 * Mutates the player state in place, which is how every system in the kernel works: the state is
 * a plain serialisable record and the tick order is fixed, so in-place mutation is deterministic
 * and avoids allocating a new object 60 times a second.
 */
export function stepPlayerMovement(
  player: PlayerState & MovementFields,
  frame: InputFrame,
  world: CollisionWorld,
): void {
  // Player Down freezes movement but not the world (AC-ARM-003.4), and ends any slide.
  if (player.downTicks > 0) {
    player.vel.x = 0;
    player.vel.z = 0;
    player.slideTicks = 0;
    return;
  }

  const wantCrouch = (frame.buttons & Buttons.Crouch) !== 0;
  const sprinting = (frame.buttons & Buttons.Sprint) !== 0 && !wantCrouch;
  const wantSlide = (frame.buttons & Buttons.Slide) !== 0;
  const jumpPressed = (frame.buttons & Buttons.Jump) !== 0;
  const hasInput = frame.moveX !== 0 || frame.moveY !== 0;

  /*
   * Start a slide. Uses last tick's grounded flag and velocity, because this tick has not moved yet.
   * The launch keeps the direction the player was already travelling and sets the speed, so a
   * slide never turns the player; steering below does that, slowly.
   */
  if (player.slideTicks === 0 && wantSlide && hasInput && player.grounded === 1) {
    const speed = fx.length2(player.vel.x, player.vel.z);
    if (speed > SLIDE_MIN_SPEED) {
      const scale = fx.div(SLIDE_SPEED, speed);
      player.vel.x = fx.mul(player.vel.x, scale);
      player.vel.z = fx.mul(player.vel.z, scale);
      player.slideTicks = SLIDE_TICKS;
    }
  }
  const sliding = player.slideTicks > 0;

  /*
   * Crouching is immediate, standing needs headroom. Without the headroom check a player could
   * crouch under low cover and stand up inside it, ending up embedded in solid geometry. A slide
   * holds the crouched body for its whole length, whether or not crouch is still held.
   */
  if (wantCrouch || sliding) {
    player.crouching = 1;
  } else if (player.crouching === 1) {
    const standShape = bodyShape(false);
    const test = resolveMove(world, player.pos, standShape, { x: 0, y: 0, z: 0 }, false);
    // If standing up would leave the body overlapping something, stay crouched.
    if (test.pos.x === player.pos.x && test.pos.y === player.pos.y && test.pos.z === player.pos.z) {
      player.crouching = 0;
    }
  }

  const crouching = player.crouching === 1;
  const shape = bodyShape(crouching);
  const grounded = isGrounded(world, player.pos, shape);

  // Coyote time: remember recent ground contact so a jump at the edge of a ledge still works.
  if (grounded) {
    player.coyoteTicks = COYOTE_TICKS;
    player.grounded = 1;
  } else {
    if (player.coyoteTicks > 0) player.coyoteTicks -= 1;
    player.grounded = 0;
  }

  // Jump buffering: a press slightly before landing still fires on the landing tick.
  if (jumpPressed) {
    player.jumpBufferTicks = JUMP_BUFFER_TICKS;
  } else if (player.jumpBufferTicks > 0) {
    player.jumpBufferTicks -= 1;
  }

  if (sliding) {
    // The slide carries its own momentum and bleeds it off; input only bends the path.
    player.vel.x = fx.mul(player.vel.x, SLIDE_FRICTION);
    player.vel.z = fx.mul(player.vel.z, SLIDE_FRICTION);
    if (hasInput) {
      const speedNow = fx.length2(player.vel.x, player.vel.z);
      const dir = worldDirection(player.yaw, frame.moveX, frame.moveY);
      player.vel.x = approach(player.vel.x, fx.mul(dir.x, speedNow), SLIDE_STEER);
      player.vel.z = approach(player.vel.z, fx.mul(dir.z, speedNow), SLIDE_STEER);
    }
  } else if (hasInput) {
    const speed = targetSpeed(sprinting, crouching);
    const dir = worldDirection(player.yaw, frame.moveX, frame.moveY);
    const accel = grounded ? GROUND_ACCEL : AIR_ACCEL;
    player.vel.x = approach(player.vel.x, fx.mul(dir.x, speed), accel);
    player.vel.z = approach(player.vel.z, fx.mul(dir.z, speed), accel);
  } else {
    const friction = grounded ? GROUND_FRICTION : AIR_FRICTION;
    player.vel.x = fx.mul(player.vel.x, friction);
    player.vel.z = fx.mul(player.vel.z, friction);
    // Kill the last fraction so a stopped player is exactly stopped and the hash settles.
    if (fx.abs(player.vel.x) < 64) player.vel.x = 0;
    if (fx.abs(player.vel.z) < 64) player.vel.z = 0;
  }

  if (player.jumpBufferTicks > 0 && player.coyoteTicks > 0) {
    player.vel.y = JUMP_VELOCITY;
    player.jumpBufferTicks = 0;
    player.coyoteTicks = 0;
    player.grounded = 0;
    // A jump ends the slide but keeps its speed, which is the point of jumping out of one.
    player.slideTicks = 0;
  } else {
    player.vel.y = (player.vel.y - GRAVITY) | 0;
    if (player.vel.y < -MAX_FALL_SPEED) player.vel.y = -MAX_FALL_SPEED | 0;
  }

  const delta: Vec3Fx = { x: player.vel.x, y: player.vel.y, z: player.vel.z };
  const result = resolveMove(world, player.pos, shape, delta, player.grounded === 1);

  player.pos = result.pos;
  // A contact zeroes the velocity on that axis; otherwise the player would keep pressing into a
  // wall and shoot off the moment it ended.
  if (result.hitX) player.vel.x = 0;
  if (result.hitZ) player.vel.z = 0;
  if (result.hitY) player.vel.y = 0;
  if (result.grounded) {
    player.grounded = 1;
    player.coyoteTicks = COYOTE_TICKS;
    if (player.vel.y < 0) player.vel.y = 0;
  }

  // A slide ends on a wall or off a ledge; otherwise it counts down.
  if (player.slideTicks > 0) {
    if (result.hitX || result.hitZ || !result.grounded) {
      player.slideTicks = 0;
    } else {
      player.slideTicks -= 1;
    }
  }
}
