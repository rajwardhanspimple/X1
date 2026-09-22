/**
 * Grey-box test arena.
 *
 * Built from primitives on purpose. Real maps arrive as hashed glTF bundles through the content
 * pipeline (WO-7) and the first authored map is WO-52; until then the renderer and the simulation
 * need a stable space to move around in, and a box-and-ramp layout is easier to reason about when
 * debugging collision than a detailed mesh.
 *
 * The collision shapes the simulation uses are NOT derived from this scene. The sim owns its own
 * collision data; this is only what the player sees.
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
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';

export const ARENA_HALF_EXTENT = 30;
const WALL_HEIGHT = 6;

export interface ArenaScene {
  scene: Scene;
  camera: FreeCamera;
  dispose(): void;
}

function flatMaterial(scene: Scene, name: string, hex: string, emissive = 0.06): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(0.04, 0.04, 0.05);
  m.emissiveColor = Color3.FromHexString(hex).scale(emissive);
  return m;
}

function buildFloor(scene: Scene): Mesh {
  const floor = MeshBuilder.CreateGround(
    'floor',
    { width: ARENA_HALF_EXTENT * 2, height: ARENA_HALF_EXTENT * 2, subdivisions: 2 },
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
  floor.receiveShadows = true;
  return floor;
}

function buildWalls(scene: Scene): Mesh[] {
  const mat = flatMaterial(scene, 'wall', '#1b2130');
  const span = ARENA_HALF_EXTENT * 2;
  const specs: Array<{ name: string; size: Vector3; pos: Vector3 }> = [
    { name: 'wallN', size: new Vector3(span, WALL_HEIGHT, 1), pos: new Vector3(0, WALL_HEIGHT / 2, ARENA_HALF_EXTENT) },
    { name: 'wallS', size: new Vector3(span, WALL_HEIGHT, 1), pos: new Vector3(0, WALL_HEIGHT / 2, -ARENA_HALF_EXTENT) },
    { name: 'wallE', size: new Vector3(1, WALL_HEIGHT, span), pos: new Vector3(ARENA_HALF_EXTENT, WALL_HEIGHT / 2, 0) },
    { name: 'wallW', size: new Vector3(1, WALL_HEIGHT, span), pos: new Vector3(-ARENA_HALF_EXTENT, WALL_HEIGHT / 2, 0) },
  ];
  return specs.map((spec) => {
    const wall = MeshBuilder.CreateBox(
      spec.name,
      { width: spec.size.x, height: spec.size.y, depth: spec.size.z },
      scene,
    );
    wall.position.copyFrom(spec.pos);
    wall.material = mat;
    wall.receiveShadows = true;
    return wall;
  });
}

/** Cover blocks at chest and head height, plus two ramps, so movement has something to read. */
function buildCover(scene: Scene): Mesh[] {
  const matLow = flatMaterial(scene, 'coverLow', '#252c3d');
  const matHigh = flatMaterial(scene, 'coverHigh', '#2d3purple'.replace('purple', '650'));
  const blocks: Mesh[] = [];

  const layout: Array<{ x: number; z: number; w: number; h: number; d: number; high: boolean }> = [
    { x: -10, z: -8, w: 4, h: 1.2, d: 4, high: false },
    { x: 10, z: -8, w: 4, h: 1.2, d: 4, high: false },
    { x: -10, z: 8, w: 4, h: 2.4, d: 2, high: true },
    { x: 10, z: 8, w: 4, h: 2.4, d: 2, high: true },
    { x: 0, z: 0, w: 6, h: 1.2, d: 6, high: false },
    { x: -20, z: 0, w: 2, h: 2.4, d: 10, high: true },
    { x: 20, z: 0, w: 2, h: 2.4, d: 10, high: true },
    { x: 0, z: -20, w: 10, h: 1.2, d: 2, high: false },
    { x: 0, z: 20, w: 10, h: 2.4, d: 2, high: true },
  ];

  layout.forEach((b, i) => {
    const box = MeshBuilder.CreateBox(
      `cover${i}`,
      { width: b.w, height: b.h, depth: b.d },
      scene,
    );
    box.position.set(b.x, b.h / 2, b.z);
    box.material = b.high ? matHigh : matLow;
    box.receiveShadows = true;
    blocks.push(box);
  });

  // Two ramps onto the tall side cover, so there is a height advantage to contest.
  const rampMat = flatMaterial(scene, 'ramp', '#20283a');
  for (const side of [-1, 1]) {
    const ramp = MeshBuilder.CreateBox(
      `ramp${side}`,
      { width: 6, height: 0.4, depth: 8 },
      scene,
    );
    ramp.position.set(side * 15, 1.2, side * -14);
    ramp.rotation.x = -0.28;
    ramp.material = rampMat;
    blocks.push(ramp);
  }

  return blocks;
}

export function buildArena(engine: AbstractEngine): ArenaScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.043, 0.051, 0.071, 1);
  scene.ambientColor = new Color3(0.12, 0.14, 0.18);
  // Nothing in the scene is clicked; skip per-frame picking work.
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.55;
  sky.diffuse = Color3.FromHexString('#8fa5c8');
  sky.groundColor = Color3.FromHexString('#141a26');

  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.3), scene);
  sun.intensity = 1.1;
  sun.position = new Vector3(20, 30, -20);

  buildFloor(scene);
  buildWalls(scene);
  buildCover(scene);

  /**
   * Placeholder camera at eye height. WO-26 replaces this with a pose driven by interpolated
   * RenderSnapshot values, and WO-49 turns it into FirstPersonCamera with view interpolation.
   */
  const camera = new FreeCamera('view', new Vector3(0, 1.7, -22), scene);
  camera.setTarget(new Vector3(0, 1.7, 0));
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
