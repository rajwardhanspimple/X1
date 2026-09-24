import { describe, expect, it } from 'vitest';
import { ARENA_MAPS } from '@rearena/sim';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { buildArena } from './arena.js';
import { TIERS } from './quality.js';

function cameraForward(camera: FreeCamera): Vector3 {
  // TargetCamera updates its cached target during view-matrix calculation, normally at render.
  camera.getViewMatrix(true);
  return camera.getTarget().subtract(camera.position).normalize();
}

describe('arena map switching', () => {
  it('keeps the same scene and camera, resets spawn, and does not leak map-owned meshes', () => {
    const engine = new NullEngine();

    try {
      const arena = buildArena(engine, TIERS.medium, ARENA_MAPS[0]!);
      const { scene, camera } = arena;
      const retained = MeshBuilder.CreateBox('retained-marker', { size: 1 }, scene);
      retained.position = new Vector3(0, 9, 0);

      const counts = new Map<string, number>();
      let previousMapId: string | null = null;

      for (let pass = 0; pass < 2; pass++) {
        for (const map of ARENA_MAPS) {
          arena.setMap(map);

          expect(arena.scene).toBe(scene);
          expect(arena.camera).toBe(camera);
          expect(scene.getMeshByName('retained-marker')).toBe(retained);
          expect(retained.isDisposed()).toBe(false);

          const floor = scene.getMeshByName(`${map.id}-floor`);
          expect(floor).not.toBeNull();
          expect(floor!.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(map.halfSize, 5);
          expect(floor!.getBoundingInfo().boundingBox.extendSize.z).toBeCloseTo(map.halfSize, 5);

          const firstBrush = map.brushes[0]!;
          expect(scene.getMeshByName(`${map.id}-${firstBrush.name}`)).not.toBeNull();

          if (previousMapId) {
            expect(scene.getMeshByName(`${previousMapId}-floor`)).toBeNull();
          }

          const spawn = map.spawns[0]!;
          expect(camera.position.x).toBeCloseTo(spawn.x, 5);
          expect(camera.position.y).toBeCloseTo((spawn.y ?? 0) + 1.65, 5);
          expect(camera.position.z).toBeCloseTo(spawn.z, 5);

          const forward = cameraForward(camera);
          const yawRad = spawn.yaw * Math.PI * 2;
          expect(forward.x).toBeCloseTo(Math.sin(yawRad), 5);
          expect(forward.z).toBeCloseTo(Math.cos(yawRad), 5);

          const meshCount = scene.meshes.length;
          const previousCount = counts.get(map.id);
          if (previousCount === undefined) counts.set(map.id, meshCount);
          else expect(meshCount).toBe(previousCount);

          previousMapId = map.id;
        }
      }

      arena.dispose();
    } finally {
      engine.dispose();
    }
  });
});
