import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RenderSnapshot } from '@rearena/protocol';
import { bindWeaponGrip, buildHumanoid, poseWeaponGrip, resetPose, RIG } from './humanoid.js';
import { EnemyRenderer } from './enemies.js';
import type { InterpolatedEnemy, InterpolatedFrame } from './interpolator.js';

let engine: NullEngine;
let scene: Scene;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

function world(node: TransformNode, point = Vector3.Zero()): Vector3 {
  if (node.parent instanceof TransformNode) world(node.parent);
  node.computeWorldMatrix(true);
  return Vector3.TransformCoordinates(point, node.getWorldMatrix());
}

const trigger = new Vector3(0, -0.075, -0.1);
const support = new Vector3(0, 0.012, 0.18);
const palmOffset = new Vector3(0, -RIG.handLength * 0.4, 0);

function fixture(detail: 'low' | 'high') {
  const rig = buildHumanoid(scene, 'test', { skin: null, dark: null, accent: null }, detail);
  const weapon = new TransformNode('test-weapon', scene);
  weapon.parent = rig.chest;
  weapon.position.set(0.1, 0.34, 0.26);
  weapon.rotation.y = 0.06;
  bindWeaponGrip(rig, weapon, trigger, support);
  return { rig, weapon };
}

function expectContact(hand: TransformNode, target: Vector3): void {
  expect(Vector3.Distance(world(hand, palmOffset), target)).toBeLessThan(0.0001);
}

describe('two-handed procedural grip', () => {
  for (const detail of ['low', 'high'] as const) {
    for (const aiming of [false, true]) {
      it(`${detail}: palms meet the rifle in ${aiming ? 'aim' : 'carry'} pose`, () => {
        const { rig, weapon } = fixture(detail);
        poseWeaponGrip(rig, aiming);
        expectContact(rig.handRight, world(weapon, trigger));
        expectContact(rig.handLeft, world(weapon, support));
        expect(world(rig.handRight, palmOffset).y).toBeGreaterThan(world(rig.pelvis).y + 0.35);
        expect(world(rig.handLeft, palmOffset).y).toBeGreaterThan(world(rig.pelvis).y + 0.35);
        for (const [shoulder, elbow, hand] of [
          [rig.shoulderLeft, rig.elbowLeft, rig.handLeft],
          [rig.shoulderRight, rig.elbowRight, rig.handRight],
        ] as const) {
          expect(Vector3.Distance(world(shoulder), world(elbow))).toBeCloseTo(
            RIG.upperArmLength,
            5,
          );
          expect(Vector3.Distance(world(elbow), world(hand))).toBeCloseTo(RIG.lowerArmLength, 5);
          expect(shoulder.rotationQuaternion).toBeNull();
          expect(elbow.rotationQuaternion).toBeNull();
        }
      });
    }
  }

  it('holds contact during chest motion, turns and all three archetype scales', () => {
    const { rig, weapon } = fixture('low');
    for (const [width, height] of [
      [0.92, 0.96],
      [1, 1],
      [1.22, 1.1],
    ] as const) {
      rig.root.scaling.set(width, height, width);
      rig.root.position.set(7, 2, -9);
      for (const yaw of [0, 0.7, 3.1]) {
        rig.root.rotation.y = yaw;
        rig.pelvis.rotation.y = 0.08;
        rig.chest.rotation.y = -0.11;
        rig.spine.rotation.x = -0.16;
        for (const aiming of [false, true]) {
          poseWeaponGrip(rig, aiming);
          expectContact(rig.handRight, world(weapon, trigger));
          expectContact(rig.handLeft, world(weapon, support));
        }
      }
    }
  });

  it('restores contact after a corpse pose and pool reset', () => {
    const { rig, weapon } = fixture('low');
    poseWeaponGrip(rig, true);
    rig.shoulderLeft.rotation.set(0.5, 0, -0.6);
    rig.elbowLeft.rotation.x = 0.3;
    resetPose(rig);
    poseWeaponGrip(rig, false);
    expectContact(rig.handRight, world(weapon, trigger));
    expectContact(rig.handLeft, world(weapon, support));
  });

  it('the old angles miss both grip points', () => {
    const { rig, weapon } = fixture('low');
    rig.shoulderRight.rotation.set(-1.18, -0.26, 0.18);
    rig.elbowRight.rotation.set(0.94, 0, 0);
    rig.shoulderLeft.rotation.set(-1.3, 0.46, -0.24);
    rig.elbowLeft.rotation.set(1.12, 0, 0);
    expect(
      Vector3.Distance(world(rig.handRight, palmOffset), world(weapon, trigger)),
    ).toBeGreaterThan(0.1);
    expect(
      Vector3.Distance(world(rig.handLeft, palmOffset), world(weapon, support)),
    ).toBeGreaterThan(0.1);
  });

  it('rejects an unreachable grip instead of stretching an arm', () => {
    const { rig, weapon } = fixture('low');
    expect(() => bindWeaponGrip(rig, weapon, trigger, new Vector3(0, 0, 5))).toThrow('outside');
  });
});

function frame(enemy: InterpolatedEnemy | null, id = 7): InterpolatedFrame {
  const player = { id: 1, x: 0, y: 1.65, z: 0, yaw: 0, pitch: 0 };
  const discrete: RenderSnapshot = {
    tick: 0,
    player,
    playerHealth: 100,
    playerDownTicks: 0,
    weaponSlot: 0,
    ammo: 30,
    reserve: 120,
    enemies: enemy ? [{ id, ...enemy }] : [],
    projectiles: [],
    score: 0,
    streak: 0,
    multiplier: 1,
    ticksRemaining: 1000,
  };
  return {
    tick: 0,
    player,
    enemies: enemy ? new Map([[id, enemy]]) : new Map(),
    projectiles: new Map(),
    discrete,
  };
}

function expectRenderedContact(): void {
  const right = scene.getMeshByName('rig-enemy-0-hand-mesh-r');
  const left = scene.getMeshByName('rig-enemy-0-hand-mesh-l');
  const grip = scene.getMeshByName('enemy-0-weapon-trigger-grip');
  const supportNode = scene.getTransformNodeByName('enemy-0-weapon-support-grip');
  if (!right || !left || !grip || !supportNode) throw new Error('Missing rifle grip or hand mesh');
  expect(right.isEnabled()).toBe(true);
  expect(left.isEnabled()).toBe(true);
  expect(grip.isEnabled()).toBe(true);
  expect(Vector3.Distance(world(right), world(grip))).toBeLessThan(0.0001);
  expect(Vector3.Distance(world(left), world(supportNode))).toBeLessThan(0.0001);
}

describe('enemy renderer grip wiring', () => {
  for (const detail of ['low', 'high'] as const) {
    it(`${detail}: keeps actual hand meshes on the weapon through animation and reuse`, () => {
      const renderer = new EnemyRenderer(scene, detail);
      const enemy: InterpolatedEnemy = {
        x: 0,
        y: 0,
        z: 3,
        yaw: 0,
        pitch: 0,
        archetype: 0,
        brain: 1,
        telegraphing: false,
        healthFraction: 1,
      };
      renderer.update(frame(enemy), 0, 1 / 60);
      expectRenderedContact();
      for (let tick = 1; tick <= 60; tick++) {
        enemy.x += 0.04;
        enemy.yaw += 0.008;
        enemy.brain = tick < 20 ? 1 : 2;
        enemy.telegraphing = tick >= 20;
        if (tick === 30) renderer.onHit(7, tick * 16);
        if (tick === 40) renderer.onShot(7, tick * 16);
        renderer.update(frame(enemy), tick * 16, 1 / 60);
        expectRenderedContact();
      }
      const generation = renderer.generation();
      renderer.onDeath(7, 1000);
      renderer.update(frame(null), 2200, 1 / 60);
      enemy.archetype = 2;
      enemy.telegraphing = false;
      enemy.brain = 1;
      renderer.update(frame(enemy, 8), 2216, 1 / 60);
      expect(renderer.generation()).toBe(generation);
      expectRenderedContact();
      renderer.dispose();
    });
  }
});
