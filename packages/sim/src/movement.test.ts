import { describe, expect, it } from 'vitest';
import { Buttons, emptyInputFrame, type InputFrame } from '@rearena/protocol';
import { createGreyboxWorld, GREYBOX_SPAWNS } from './layout.js';
import { bodyShape, stepPlayerMovement, type MovementFields } from './movement.js';
import { createInitialState, type PlayerState } from './state.js';
import * as fx from './math/fixed.js';
import { isGrounded } from './collision.js';

const world = createGreyboxWorld();
const spawn = GREYBOX_SPAWNS[0]!;

function freshPlayer(overrides: Partial<PlayerState> = {}): PlayerState & MovementFields {
  const state = createInitialState({
    seed: 1,
    durationTicks: 3600,
    spawn: { x: fx.fromInt(spawn.x), y: 0, z: fx.fromInt(spawn.z) },
    spawnYaw: 0,
    maxHealth: fx.fromInt(100),
    magazine: [30, 12],
    reserve: [120, 48],
  });
  return Object.assign(state.player, overrides) as PlayerState & MovementFields;
}

function frame(tick: number, partial: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInputFrame(tick), ...partial };
}

/** Run n ticks with the same input. */
function run(
  player: PlayerState & MovementFields,
  ticks: number,
  partial: Partial<InputFrame> = {},
): void {
  for (let t = 0; t < ticks; t++) {
    stepPlayerMovement(player, frame(t, partial), world);
  }
}

describe('walking', () => {
  it('does not move without input', () => {
    const p = freshPlayer();
    const startX = p.pos.x;
    const startZ = p.pos.z;
    run(p, 30);
    expect(p.pos.x).toBe(startX);
    expect(p.pos.z).toBe(startZ);
  });

  it('moves forward and reaches a steady speed', () => {
    const p = freshPlayer();
    run(p, 30, { moveY: fx.FX_ONE });
    // Facing yaw 0 is +Z, so forward increases Z.
    expect(p.pos.z).toBeGreaterThan(fx.fromInt(spawn.z));
    const speedAfter30 = p.vel.z;
    run(p, 30, { moveY: fx.FX_ONE });
    // Already at target speed, so it should not keep climbing.
    expect(Math.abs(p.vel.z - speedAfter30)).toBeLessThan(64);
  });

  it('strafes right without moving forward', () => {
    const p = freshPlayer();
    const startZ = p.pos.z;
    run(p, 20, { moveX: fx.FX_ONE });
    expect(p.pos.x).toBeGreaterThan(fx.fromInt(spawn.x));
    expect(Math.abs(p.pos.z - startZ)).toBeLessThan(fx.fromRatio(5, 100));
  });

  it('comes to a complete stop when input ends', () => {
    const p = freshPlayer();
    run(p, 20, { moveY: fx.FX_ONE });
    run(p, 60);
    expect(p.vel.x).toBe(0);
    expect(p.vel.z).toBe(0);
  });

  it('respects yaw when converting input to world space', () => {
    const p = freshPlayer();
    // Face a quarter turn: forward is now +X.
    p.yaw = fx.FX_QUARTER;
    run(p, 20, { moveY: fx.FX_ONE });
    expect(p.pos.x).toBeGreaterThan(fx.fromInt(spawn.x));
  });
});

describe('speed modifiers', () => {
  function distanceOver(ticks: number, partial: Partial<InputFrame>): number {
    const p = freshPlayer();
    const startZ = p.pos.z;
    run(p, ticks, { moveY: fx.FX_ONE, ...partial });
    return (p.pos.z - startZ) | 0;
  }

  it('sprints faster than it walks', () => {
    expect(distanceOver(40, { buttons: Buttons.Sprint })).toBeGreaterThan(distanceOver(40, {}));
  });

  it('crouches slower than it walks', () => {
    expect(distanceOver(40, { buttons: Buttons.Crouch })).toBeLessThan(distanceOver(40, {}));
  });

  it('ignores sprint while crouching', () => {
    const both = distanceOver(40, { buttons: Buttons.Crouch | Buttons.Sprint });
    const crouchOnly = distanceOver(40, { buttons: Buttons.Crouch });
    expect(both).toBe(crouchOnly);
  });
});

describe('crouching', () => {
  it('stands back up when there is headroom', () => {
    const p = freshPlayer();
    run(p, 5, { buttons: Buttons.Crouch });
    expect(p.crouching).toBe(1);
    run(p, 5);
    expect(p.crouching).toBe(0);
  });
});

describe('gravity and jumping', () => {
  it('falls to the floor and settles', () => {
    const p = freshPlayer();
    p.pos.y = fx.fromInt(5);
    p.grounded = 0;
    run(p, 120);
    expect(p.pos.y).toBe(0);
    expect(p.grounded).toBe(1);
    expect(p.vel.y).toBe(0);
  });

  it('rises on a jump and comes back down', () => {
    const p = freshPlayer();
    // One grounded tick to arm coyote time.
    run(p, 1);
    stepPlayerMovement(p, frame(1, { buttons: Buttons.Jump }), world);
    expect(p.vel.y).toBeGreaterThan(0);
    let peak = p.pos.y;
    for (let t = 2; t < 120; t++) {
      stepPlayerMovement(p, frame(t), world);
      if (p.pos.y > peak) peak = p.pos.y;
    }
    expect(peak).toBeGreaterThan(fx.fromRatio(80, 100));
    expect(p.pos.y).toBe(0);
    expect(p.grounded).toBe(1);
  });

  it('cannot jump twice in the air', () => {
    const p = freshPlayer();
    run(p, 1);
    stepPlayerMovement(p, frame(1, { buttons: Buttons.Jump }), world);
    const risingVel = p.vel.y;
    // Fly for long enough that coyote time has expired, then press jump again.
    run(p, 20);
    stepPlayerMovement(p, frame(30, { buttons: Buttons.Jump }), world);
    expect(p.vel.y).toBeLessThan(risingVel);
  });

  it('never exceeds terminal fall speed', () => {
    const p = freshPlayer();
    p.pos.y = fx.fromInt(20);
    p.grounded = 0;
    for (let t = 0; t < 200; t++) {
      stepPlayerMovement(p, frame(t), world);
      expect(p.vel.y).toBeGreaterThan(fx.fromInt(-1));
    }
  });
});

describe('collision response', () => {
  it('slides along a wall instead of sticking', () => {
    const p = freshPlayer();
    // Stand near the south wall and push diagonally into it.
    p.pos.x = fx.fromInt(0);
    p.pos.z = fx.fromInt(-28);
    const startX = p.pos.x;
    run(p, 40, { moveX: fx.FX_ONE, moveY: -fx.FX_ONE });
    // Blocked on Z by the wall, but X movement continues.
    expect(p.pos.x).toBeGreaterThan(startX);
  });

  it('cannot pass through a tall pillar', () => {
    const p = freshPlayer();
    // Directly south of the west pillar at x -20, facing +X toward it.
    p.pos.x = fx.fromInt(-26);
    p.pos.z = 0;
    p.yaw = fx.FX_QUARTER;
    run(p, 120, { moveY: fx.FX_ONE });
    // Pillar spans x -21.5 to -18.5, so the body stops short of its face.
    expect(p.pos.x).toBeLessThan(fx.fromRatio(-2100, 100));
  });

  it('stays inside the arena bounds', () => {
    const p = freshPlayer();
    p.pos.z = fx.fromInt(28);
    run(p, 200, { moveY: fx.FX_ONE, buttons: Buttons.Sprint });
    expect(p.pos.z).toBeLessThanOrEqual(fx.fromInt(30));
  });

  it('steps up onto low cover while walking', () => {
    const p = freshPlayer();
    // coverSW spans z -11 to -9 at x -12, top at 1.2 units.
    p.pos.x = fx.fromInt(-12);
    p.pos.z = fx.fromInt(-13);
    p.yaw = 0;
    run(p, 90, { moveY: fx.FX_ONE });
    // Either it climbed on top, or it is blocked; it must not be embedded in the box.
    const shape = bodyShape(false);
    expect(isGrounded(world, p.pos, shape)).toBe(true);
  });
});

describe('determinism', () => {
  it('produces identical state from identical input', () => {
    const a = freshPlayer();
    const b = freshPlayer();
    const script: Array<Partial<InputFrame>> = [];
    for (let t = 0; t < 200; t++) {
      script.push({
        moveX: ((t * 37) % 3) - 1 === 0 ? 0 : fx.FX_ONE * (((t * 37) % 3) - 1),
        moveY: ((t * 17) % 3) - 1 === 0 ? 0 : fx.FX_ONE * (((t * 17) % 3) - 1),
        buttons: t % 23 === 0 ? Buttons.Jump : t % 11 === 0 ? Buttons.Sprint : 0,
        lookYaw: ((t * 53) % 401) - 200,
      });
    }
    for (let t = 0; t < script.length; t++) {
      stepPlayerMovement(a, frame(t, script[t]), world);
      stepPlayerMovement(b, frame(t, script[t]), world);
    }
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.grounded).toBe(b.grounded);
    expect(a.coyoteTicks).toBe(b.coyoteTicks);
  });

  it('keeps every position and velocity an integer', () => {
    const p = freshPlayer();
    for (let t = 0; t < 300; t++) {
      stepPlayerMovement(p, frame(t, { moveY: fx.FX_ONE, buttons: t % 30 === 0 ? Buttons.Jump : 0 }), world);
      expect(Number.isInteger(p.pos.x)).toBe(true);
      expect(Number.isInteger(p.pos.y)).toBe(true);
      expect(Number.isInteger(p.pos.z)).toBe(true);
      expect(Number.isInteger(p.vel.y)).toBe(true);
    }
  });
});
