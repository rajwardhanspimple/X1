/**
 * Greybox arena meshes.
 *
 * Geometry is generated from GREYBOX_BRUSHES in @rearena/sim, which is the same list the
 * simulation turns into collision boxes. That is the point: when the renderer declared its own
 * boxes there was nothing stopping the two from drifting, and a mismatch shows up as an invisible
 * wall or as cover you can shoot through.
 *
 * Real maps replace this with hashed glTF bundles whose collision is extracted at build time
 * (WO-7), which enforces the same property for authored content.
 */

import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { ARENA_HALF, GREYBOX_BRUSHES, type BrushDescriptor } from '@rearena/sim';

export interface ArenaScene {
  scene: Scene;
  camera: FreeCamera;
  dispose(): void;
}

const BRUSH_COLOURS: Record<BrushDescriptor['kind'], string> = {
  wall: '#1b2130',
  coverLow: '#252c3d',
  coverHigh: '#2d3650',
  platform: '#222a3b',
};

function flatMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(0.04, 0.04, 0.05);
  m.emissiveColor = Color3.FromHexString(hex).scale(0.08);
  return m;
}

export function buildArena(engine: AbstractEngine): ArenaScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.043, 0.051, 0.071, 1);
  scene.ambientColor = new Color3(0.12, 0.14, 0.18);
  // Nothing in the scene is clicked; skip per-frame picking work.
  scene.skipPointerMovePicking = true;

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.6;
  sky.diffuse = Color3.FromHexString('#8fa5c8');
  sky.groundColor = Color3.FromHexString('#141a26');

  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.3), scene);
  sun.intensity = 1.05;
  sun.position = new Vector3(20, 30, -20);

  const floor = MeshBuilder.CreateGround(
    'floor',
    { width: ARENA_HALF * 2, height: ARENA_HALF * 2, subdivisions: 2 },
    scene,
  );
  const grid = new GridMaterial('floorGrid', scene);
  grid.majorUnitFrequency = 5;
  grid.minorUnitVisibility = 0.4;
  grid.gridRatio = 1;
  grid.mainColor = Color3.FromHexString('#0e1117');
  grid.lineColor = Color3.FromHexString('#2b3345');
  grid.opacity = 0.99;
  floor.material = grid;

  // One material per kind, shared across every brush of that kind, so draw calls stay low.
  const materials = new Map<BrushDescriptor['kind'], StandardMaterial>();
  for (const [kind, hex] of Object.entries(BRUSH_COLOURS) as Array<
    [BrushDescriptor['kind'], string]
  >) {
    materials.set(kind, flatMaterial(scene, `brush-${kind}`, hex));
  }

  for (const brush of GREYBOX_BRUSHES) {
    const mesh = MeshBuilder.CreateBox(
      brush.name,
      { width: brush.width, height: brush.height, depth: brush.depth },
      scene,
    );
    mesh.position.set(brush.x, brush.y, brush.z);
    mesh.material = materials.get(brush.kind) ?? null;
    mesh.freezeWorldMatrix();
  }

  /**
   * Camera position and orientation are written every frame from the interpolated snapshot, so it
   * carries no controls of its own. FirstPersonCamera with weapon view models lands in WO-49.
   */
  const camera = new FreeCamera('view', new Vector3(0, 1.65, -24), scene);
  camera.minZ = 0.1;
  camera.maxZ = 200;
  camera.fov = 1.25;

  return {
    scene,
    camera,
    dispose() {
      scene.dispose();
    },
  };
}
