import { describe, expect, it } from 'vitest';
import { Buttons, emptyInputFrame, InputFlags, type InputFrame } from '@rearena/protocol';
import {
  createSimulation,
  hashSimulation,
  isCheckpointTick,
  step,
  summary,
  SIM_VERSION,
  type SimContent,
  type Simulation,
} from './kernel.js';
import { replay } from './replay.js';
import { createGreyboxWorld, greyboxEnemySpawns, greyboxPlayerSpawns } from './layout.js';
import { computeAimAssist } from './aim-assist.js';
import { createCollisionWorld, type BoxFx } from './collision.js';
import { Brain } from './enemies.js';
import * as fx from './math/fixed.js';
import type { EnemyState } from './state.js';

function testContent(): SimContent {
  const world = createGreyboxWorld();
  return {
    hash: 'aimassist000001',
    durationTicks: 1800,
    boxes: world.boxes,
    bounds: world.bounds,
    spawns: greyboxPlayerSpawns(),
    spawnYaw: 0,
    enemySpawns: greyboxEnemySpawns(),
    maxHealth: fx.fromInt(100),
    weapons: ['rifle-01', 'pistol-01'],
  };
}

const content = testContent();

function config(seed = 4242) {
  return {
    mapId: 'test-arena',
    modeId: 'test-mode',
    seed,
    simVersion: SIM_VERSION,
    contentHash: content.hash,
    loadout: { primaryWeapon: 'rifle-01', secondaryWeapon: 'pistol-01', perks: [] },
  };
}

/** A complete EnemyState at a position, so tests control geometry rather than waiting for a wave. */
function enemyAt(x: fx.Fx, y: fx.Fx, z: fx.Fx, id = 1): EnemyState {
  return {
    id,
    archetype: 1,
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    health: fx.fromInt(100),
    brain: Brain.Advance,
    brainTicks: 0,
    targetNode: 0,
    reactionTicks: 0,
    fireCooldownTicks: 0,
  };
}

/** Place a single enemy at an integer offset from the player. */
function placeEnemy(sim: Simulation, dx: number, dz: number, id = 1): EnemyState {
  const p = sim.state.player;
  const enemy = enemyAt(
    (p.pos.x + fx.fromInt(dx)) | 0,
    p.pos.y,
    (p.pos.z + fx.fromInt(dz)) | 0,
    id,
  );
  sim.state.enemies = [enemy];
  return enemy;
}

/** A frame with the assist flag set, so the sim applies magnetism. */
function assistFrame(tick: number, extra: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInputFrame(tick), flags: InputFlags.AimAssist, ...extra };
}

describe('aim assist gating', () => {
  it('does nothing without the flag', () => {
    // AC-INP-GP-004.2: assist is off for every non-gamepad scheme, and those frames carry no flag.
    const sim = createSimulation(config(), content);
    placeEnemy(sim, 2, 10);
    const before = sim.state.player.yaw;
    step(sim, emptyInputFrame(0));
    expect(sim.state.player.yaw).toBe(before);
  });

  it('pulls toward a target when the flag is set', () => {
    // AC-INP-GP-004.1: on by default for gamepad, which is expressed as the recorded flag.
    const sim = createSimulation(config(), content);
    placeEnemy(sim, 2, 10);
    const before = sim.state.player.yaw;
    step(sim, assistFrame(0));
    expect(sim.state.player.yaw).not.toBe(before);
  });

  it('does not assist a downed player', () => {
    const sim = createSimulation(config(), content);
    placeEnemy(sim, 2, 10);
    sim.state.player.downTicks = 60;
    const before = sim.state.player.yaw;
    step(sim, assistFrame(0));
    expect(sim.state.player.yaw).toBe(before);
  });

  it('does not assist toward a dead enemy', () => {
    const sim = createSimulation(config(), content);
    const enemy = placeEnemy(sim, 2, 10);
    enemy.health = 0;
    const before = sim.state.player.yaw;
    step(sim, assistFrame(0));
    expect(sim.state.player.yaw).toBe(before);
  });

  it('ignores a target outside the cone', () => {
    const sim = createSimulation(config(), content);
    // Directly to the player's right: about a quarter turn away, far outside an 11-degree cone.
    placeEnemy(sim, 10, 0);
    const before = sim.state.player.yaw;
    step(sim, assistFrame(0));
    expect(sim.state.player.yaw).toBe(before);
  });

  it('ignores a target beyond maximum range', () => {
    const sim = createSimulation(config(), content);
    // Straight ahead but far away. MAX_RANGE is 45 units.
    placeEnemy(sim, 0, 80);
    const before = sim.state.player.yaw;
    step(sim, assistFrame(0));
    expect(sim.state.player.yaw).toBe(before);
  });
});

describe('aim assist bounds', () => {
  it('rotates by no more than the per-tick cap', () => {
    /*
     * The whole difference between assist and an aimbot is this number. An enemy at the edge of the cone gets
     * the maximum pull, and that maximum must stay small enough to read as help.
     */
    const sim = createSimulation(config(), content);
    placeEnemy(sim, 2, 10);
    const before = sim.state.player.yaw;
    step(sim, assistFrame(0));
    const moved = fx.abs(fx.angleDiffTurns(sim.state.player.yaw, before));
    // MAX_PULL_TURNS is 0.0016 turns. Allow one unit of fixed-point slack.
    expect(moved).toBeLessThanOrEqual(fx.fromRatio(16, 10000) + 1);
  });

  it('never overshoots a nearly centred target', () => {
    const sim = createSimulation(config(), content);
    // Almost straight ahead: the pull must stop at the target, not cross it.
    placeEnemy(sim, 0, 10);
    const world = createCollisionWorld(content.boxes, content.bounds);

    for (let t = 0; t < 40; t++) {
      const assist = computeAimAssist(sim.state, assistFrame(t), world);
      if (assist.targetId === 0) break;
      step(sim, assistFrame(t));
      // Yaw must approach zero from one side without ever flipping past it.
      const off = fx.abs(fx.angleDiffTurns(sim.state.player.yaw, 0));
      expect(off).toBeLessThan(fx.fromRatio(4, 100));
    }
  });

  it('weakens as the target centres', () => {
    /*
     * The taper is what stops assist fighting the player once they have acquired a target. Pull at the cone
     * edge must exceed pull near the centre.
     */
    const world = createCollisionWorld(content.boxes, content.bounds);

    const edge = createSimulation(config(), content);
    placeEnemy(edge, 2, 10);
    const edgePull = computeAimAssist(edge.state, assistFrame(0), world);

    const centred = createSimulation(config(), content);
    placeEnemy(centred, 0, 10);
    const centredPull = computeAimAssist(centred.state, assistFrame(0), world);

    const edgeMagnitude = fx.length2(fx.abs(edgePull.yawPull), fx.abs(edgePull.pitchPull));
    const centredMagnitude = fx.length2(fx.abs(centredPull.yawPull), fx.abs(centredPull.pitchPull));
    expect(edgeMagnitude).toBeGreaterThan(centredMagnitude);
  });

  it('reduces look sensitivity while a target is held', () => {
    const sim = createSimulation(config(), content);
    placeEnemy(sim, 1, 10);

    const plain = createSimulation(config(), content);
    // No enemy, so no slowdown: the same stick input must rotate further.
    plain.state.enemies = [];

    const look = fx.fromRatio(1, 100);
    const beforeAssisted = sim.state.player.yaw;
    const beforePlain = plain.state.player.yaw;

    step(sim, assistFrame(0, { lookYaw: look }));
    step(plain, assistFrame(0, { lookYaw: look }));

    const assistedTravel = fx.abs(fx.angleDiffTurns(sim.state.player.yaw, beforeAssisted));
    const plainTravel = fx.abs(fx.angleDiffTurns(plain.state.player.yaw, beforePlain));
    expect(assistedTravel).toBeLessThan(plainTravel);
  });
});

describe('aim assist and geometry', () => {
  it('does not pull toward an enemy behind cover', () => {
    /*
     * Assist must use the same line of sight bullets use. Pulling toward a target behind a wall would fight
     * the player while every shot hit the wall, which is worse than no assist at all.
     *
     * The test builds its own two-box world rather than hunting the greybox for a blocking direction: a
     * search-based version can pass because no target was in range at all, which proves nothing about the
     * sight check. Here the ONLY difference between the two cases is the presence of the wall.
     */
    const eyeY = fx.fromRatio(160, 100);
    const floor: BoxFx = {
      minX: fx.fromInt(-20),
      maxX: fx.fromInt(20),
      minY: fx.fromInt(-1),
      maxY: 0,
      minZ: fx.fromInt(-20),
      maxZ: fx.fromInt(20),
    };
    // A wall five units ahead, tall and wide enough to cover the whole sight line.
    const wall: BoxFx = {
      minX: fx.fromInt(-4),
      maxX: fx.fromInt(4),
      minY: 0,
      maxY: fx.fromInt(4),
      minZ: fx.fromInt(4),
      maxZ: fx.fromInt(5),
    };
    const bounds: BoxFx = floor;

    const withWall = createCollisionWorld([floor, wall], bounds);
    const withoutWall = createCollisionWorld([floor], bounds);

    const sim = createSimulation(config(), content);
    // Stand at the origin looking down +Z, with the enemy ten units ahead: behind the wall.
    sim.state.player.pos = { x: 0, y: 0, z: 0 };
    sim.state.player.yaw = 0;
    sim.state.player.pitch = 0;
    sim.state.enemies = [enemyAt(0, 0, fx.fromInt(10), 5)];

    const blocked = computeAimAssist(sim.state, assistFrame(0), withWall);
    const clear = computeAimAssist(sim.state, assistFrame(0), withoutWall);

    expect(blocked.targetId).toBe(0);
    expect(clear.targetId).toBe(5);
    // Sanity: the eye really is below the top of the wall, so the block is not an accident of height.
    expect(eyeY).toBeLessThan(wall.maxY);
  });

  it('picks the more centred of two targets', () => {
    const sim = createSimulation(config(), content);
    const world = createCollisionWorld(content.boxes, content.bounds);
    const p = sim.state.player;

    // id 7 is nearly straight ahead; id 3 is further off-axis but closer. Centred must win.
    sim.state.enemies = [
      enemyAt((p.pos.x + fx.fromRatio(25, 10)) | 0, p.pos.y, (p.pos.z + fx.fromInt(6)) | 0, 3),
      enemyAt((p.pos.x + fx.fromRatio(2, 10)) | 0, p.pos.y, (p.pos.z + fx.fromInt(12)) | 0, 7),
    ];
    const assist = computeAimAssist(sim.state, assistFrame(0), world);
    expect(assist.targetId).toBe(7);
  });
});

describe('aim assist determinism', () => {
  /** A scripted log that moves, looks and fires with assist enabled throughout. */
  function recordAssistedLog(ticks: number) {
    const cfg = config(909);
    const sim = createSimulation(cfg, content);
    const frames: InputFrame[] = [];
    const checkpoints: { tick: number; hash: string }[] = [];

    for (let t = 0; t < ticks; t++) {
      const frame: InputFrame = {
        ...emptyInputFrame(t),
        flags: InputFlags.AimAssist,
        moveY: t % 90 < 45 ? fx.FX_ONE : -fx.FX_ONE,
        moveX: t % 60 < 30 ? fx.FX_ONE : 0,
        lookYaw: ((t * 23) % 97) - 48,
        lookPitch: ((t * 11) % 41) - 20,
        buttons: (t % 11 < 4 ? Buttons.Fire : 0) | (t % 150 === 120 ? Buttons.Reload : 0),
      };
      frames.push(frame);
      step(sim, frame);
      if (isCheckpointTick(sim)) {
        checkpoints.push({ tick: sim.state.tick, hash: hashSimulation(sim) });
      }
    }

    return {
      clientRunId: '00000000-0000-4000-8000-00000000aa23',
      matchConfig: cfg,
      clientVersion: 'test',
      frames,
      checkpoints,
      summary: summary(sim),
    };
  }

  it('replays an assisted run to the same hash', () => {
    /*
     * The load-bearing test for ADR-001. The assist flag travels in the recorded frame, so a replay applies
     * exactly the same assist the player had. If this breaks, every honest gamepad run is rejected.
     */
    const log = recordAssistedLog(420);
    const result = replay({ log, content });
    expect(result.mismatchTick).toBeNull();
    expect(result.summary.finalHash).toBe(log.summary.finalHash);
    expect(result.checkpoints).toEqual(log.checkpoints);
  });

  it('produces the same result on repeated runs', () => {
    const log = recordAssistedLog(240);
    const a = replay({ log, content });
    const b = replay({ log, content });
    expect(a.summary.finalHash).toBe(b.summary.finalHash);
  });

  it('assisted and unassisted runs diverge', () => {
    // If these matched, assist would not be doing anything and the version bump would be pointless.
    const assisted = createSimulation(config(77), content);
    const plain = createSimulation(config(77), content);

    for (let t = 0; t < 300; t++) {
      const base = { ...emptyInputFrame(t), moveY: fx.FX_ONE, lookYaw: ((t * 19) % 61) - 30 };
      step(assisted, { ...base, flags: InputFlags.AimAssist });
      step(plain, base);
    }

    expect(hashSimulation(assisted)).not.toBe(hashSimulation(plain));
  });

  it('consumes no RNG', () => {
    /*
     * Assist must not draw a random value. Drawing one would shift every subsequent draw in the run, so an
     * optional comfort feature would invalidate existing golden replays.
     *
     * All four sub-streams are compared. They are separate precisely so that a change in one system cannot
     * move an outcome in another, and this test is what holds assist to that rule.
     */
    const assisted = createSimulation(config(31), content);
    const plain = createSimulation(config(31), content);

    // Stand still, fire nothing: assist runs its selection, and nothing else consumes randomness.
    for (let t = 0; t < 120; t++) {
      step(assisted, assistFrame(t));
      step(plain, emptyInputFrame(t));
    }

    expect(assisted.state.rngSpawn).toEqual(plain.state.rngSpawn);
    expect(assisted.state.rngSpread).toEqual(plain.state.rngSpread);
    expect(assisted.state.rngAi).toEqual(plain.state.rngAi);
    expect(assisted.state.rngMisc).toEqual(plain.state.rngMisc);
  });
});
