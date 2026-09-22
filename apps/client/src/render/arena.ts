/**
 * Greybox arena.
 *
 * Geometry is generated from GREYBOX_BRUSHES in @rearena/sim, the same list the simulation turns
 * into collision boxes. When the renderer declared its own boxes there was nothing stopping the two
 * from drifting, and a mismatch shows up as an invisible wall or cover you can shoot through.
 *
 * Lighting matters more than it looks like it should. A flat-lit box arena gives the eye nothing to
 * judge distance with, which is why the first version felt like a diagram. Fog, a shadow map and a
 * little colour variation per surface do most of the work of making a space feel physical.
 *
 * Quality is applied here rather than read from a global: the arena owns its lights and camera, so it
 * is the only place that can change them coherently.
 */

import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { ARENA_HALF, GREYBOX_BRUSHES, WALL_HEIGHT, type BrushDescriptor } from '@rearena/sim';
import type { QualityTier } from './quality.js';

export interface ArenaScene {
  scene: Scene;
  camera: FreeCamera;
  /** Apply a tier mid-session. Shadows are rebuilt because map size is fixed at construction. */
  applyTier(tier: QualityTier): void;
  addShadowCasters(meshes: Mesh[]): void;
  dispose(): void;
}

/** Slightly different tones per brush kind, so surfaces separate instead of merging. */
const BRUSH_COLOURS: Record<BrushDescriptor['kind'], string> = {
  wall: '#252b38',
  coverLow: '#313949',
  coverHigh: '#39425a',
  platform: '#2b3242',
};

function surfaceMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  // Low but non-zero specular: a completely matte surface reads as unlit paper.
  m.specularColor = new Color3(0.08, 0.09, 0.11);
  m.specularPower = 48;
  m.ambientColor = Color3.FromHexString(hex).scale(0.5);
  return m;
}

export function buildArena(engine: AbstractEngine, tier: QualityTier): ArenaScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.055, 0.065, 0.09, 1);
  scene.ambientColor = new Color3(0.2, 0.22, 0.28);
  scene.skipPointerMovePicking = true;

  /*
   * Exponential fog. The cheapest thing that makes a space readable: without it, a wall 5 units away
   * and one 40 units away are the same brightness and the eye has nothing to judge depth with. It
   * also hides the draw-distance cut on lower tiers, which would otherwise be a hard edge.
   */
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(0.07, 0.085, 0.12);

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.42;
  sky.diffuse = Color3.FromHexString('#7f95bd');
  sky.groundColor = Color3.FromHexString('#181d29');

  // A single directional light with a shadow map. Shadows are what make an object sit on the floor
  // rather than hover above it.
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.35), scene);
  sun.position = new Vector3(26, 42, -26);
  sun.intensity = 1.25;
  sun.diffuse = Color3.FromHexString('#fff2dc');

  const floor = MeshBuilder.CreateGround(
    'floor',
    { width: ARENA_HALF * 2, height: ARENA_HALF * 2, subdivisions: 2 },
    scene,
  );
  const grid = new GridMaterial('floorGrid', scene);
  grid.majorUnitFrequency = 5;
  grid.minorUnitVisibility = 0.35;
  grid.gridRatio = 1;
  grid.mainColor = Color3.FromHexString('#141a26');
  grid.lineColor = Color3.FromHexString('#33405c');
  grid.opacity = 0.99;
  floor.material = grid;
  floor.receiveShadows = true;

  // One material per kind, shared across every brush of that kind, so draw calls stay low.
  const materials = new Map<BrushDescriptor['kind'], StandardMaterial>();
  for (const [kind, hex] of Object.entries(BRUSH_COLOURS) as Array<
    [BrushDescriptor['kind'], string]
  >) {
    materials.set(kind, surfaceMaterial(scene, `brush-${kind}`, hex));
  }

  const arenaCasters: Mesh[] = [];
  for (const brush of GREYBOX_BRUSHES) {
    const mesh = MeshBuilder.CreateBox(
      brush.name,
      { width: brush.width, height: brush.height, depth: brush.depth },
      scene,
    );
    mesh.position.set(brush.x, brush.y, brush.z);
    mesh.material = materials.get(brush.kind) ?? null;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    // The arena never moves, so its transforms can be computed once.
    mesh.freezeWorldMatrix();
    if (brush.kind !== 'wall') arenaCasters.push(mesh);
  }

  /*
   * Emissive strips along the top of each wall. Two jobs: they give the arena a sense of being lit
   * from somewhere, and they stop the upper corners reading as flat black where fog and shadow meet.
   */
  const stripMaterial = new StandardMaterial('wall-strip', scene);
  stripMaterial.emissiveColor = Color3.FromHexString('#4fd1c5').scale(0.55);
  stripMaterial.diffuseColor = Color3.Black();
  stripMaterial.disableLighting = true;

  const stripSpecs: Array<{ x: number; z: number; w: number; d: number }> = [
    { x: 0, z: ARENA_HALF - 0.6, w: ARENA_HALF * 2, d: 0.12 },
    { x: 0, z: -ARENA_HALF + 0.6, w: ARENA_HALF * 2, d: 0.12 },
    { x: ARENA_HALF - 0.6, z: 0, w: 0.12, d: ARENA_HALF * 2 },
    { x: -ARENA_HALF + 0.6, z: 0, w: 0.12, d: ARENA_HALF * 2 },
  ];
  for (const [i, spec] of stripSpecs.entries()) {
    const strip = MeshBuilder.CreateBox(
      `wall-strip-${i}`,
      { width: spec.w, height: 0.1, depth: spec.d },
      scene,
    );
    strip.position.set(spec.x, WALL_HEIGHT - 0.5, spec.z);
    strip.material = stripMaterial;
    strip.isPickable = false;
    strip.freezeWorldMatrix();
  }

  /**
   * Camera position and orientation are written every frame by the CameraRig from the interpolated
   * snapshot, so it carries no controls of its own.
   */
  const camera = new FreeCamera('view', new Vector3(0, 1.65, -24), scene);
  camera.minZ = 0.08;
  camera.fov = 1.25;

  let shadows: ShadowGenerator | null = null;
  /** Casters registered by other systems, replayed onto a rebuilt generator. */
  const externalCasters: Mesh[] = [];

  function applyTier(next: QualityTier): void {
    scene.fogDensity = next.fogDensity;
    camera.maxZ = next.drawDistance;

    /*
     * A ShadowGenerator's map size is fixed when it is constructed, so changing tier means disposing
     * and rebuilding. That is acceptable because tier changes happen from a menu, not mid-fight.
     */
    const wantSize = next.shadowMapSize;
    const currentSize = shadows?.mapSize ?? 0;
    if (wantSize !== currentSize) {
      shadows?.dispose();
      shadows = null;
      if (wantSize > 0) {
        shadows = new ShadowGenerator(wantSize, sun);
        shadows.darkness = 0.45;
        shadows.bias = 0.002;
        for (const mesh of arenaCasters) shadows.addShadowCaster(mesh);
        for (const mesh of externalCasters) shadows.addShadowCaster(mesh);
      }
    }

    if (shadows) {
      // Blur is a separate cost from resolution, so it is a tier decision of its own.
      shadows.useBlurExponentialShadowMap = next.shadowBlur;
      shadows.useExponentialShadowMap = !next.shadowBlur;
      shadows.blurKernel = next.shadowBlur ? 24 : 1;
    }
  }

  applyTier(tier);

  return {
    scene,
    camera,
    applyTier,
    addShadowCasters(meshes: Mesh[]) {
      for (const mesh of meshes) {
        externalCasters.push(mesh);
        shadows?.addShadowCaster(mesh);
      }
    },
    dispose() {
      shadows?.dispose();
      scene.dispose();
    },
  };
}
