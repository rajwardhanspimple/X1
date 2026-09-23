/**
 * The container yard.
 *
 * Geometry comes from GREYBOX_BRUSHES in @rearena/sim, the same list the simulation turns into collision boxes. When the renderer
 * declared its own boxes there was nothing stopping the two from drifting, and a mismatch shows up as an invisible wall or as cover
 * you can shoot through.
 *
 * Every dimension is read from the layout. An earlier version of the decoration hardcoded an arena half-width of 24 while the layout
 * said 30, so the wall detail floated 6 units inside the actual walls for several commits without anyone noticing.
 *
 * ## Lighting
 *
 * The arena once rendered as black boxes with glowing lines, and the lesson generalises:
 *
 * A surface colour that looks right as a swatch is far too dark once it is only lit indirectly. Pick the value you want to SEE.
 *
 * One directional light leaves every face turned away from it lit by ambient alone, which is how cover became featureless slabs. Fill
 * lights opposite the key cost nothing (no shadow map, no extra draw call) and are what give a box its shape.
 *
 * In a scene lit from above, bounce off the floor is not optional, or everything below waist height goes black.
 *
 * An emissive value only means something relative to the lit surfaces around it. Tuning one without the other is what produced an
 * arena that looked like neon in a void.
 *
 * ## Container colour
 *
 * Containers take one of six shipping colours, selected by hashing the brush name. Hashing rather than randomising keeps the choice
 * stable across reloads, which is what lets a player say "the red stack by the north wall" and have it mean something next round. Six
 * shared materials, so the variety costs nothing in draw calls.
 */

import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
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
  /** Per-frame work: the beacon animation. */
  update(now: number): void;
  dispose(): void;
}

/**
 * Shipping container colours: weathered rather than saturated, so they read as painted steel that has been outdoors.
 *
 * Deliberately distinct from the enemy archetype tints (#e0644f red, #e0a94f amber, #b44fe0 purple). A container matching an enemy
 * colour would make a distant figure hard to pick out against it, trading visual interest for a readability loss.
 */
const CONTAINER_COLOURS = [
  '#8c4a3f', // oxide red
  '#3f6b8c', // faded blue
  '#4a7c59', // weathered green
  '#8c7a3f', // desert tan
  '#5e5a56', // gunmetal
  '#7a6a5d', // rust brown
] as const;

/** Accent colour per compass side, on the perimeter wall strips. */
const SIDE_ACCENTS = {
  north: '#4f8ce0',
  south: '#4fe0a9',
  east: '#e0d24f',
  west: '#9d4fe0',
} as const;

/**
 * Pick a container colour from a name.
 *
 * A small string hash, so the same brush always gets the same colour. Stability is the point: a player who learns the yard by its
 * colours must find it unchanged next round, and this achieves that with no stored state and no authoring step.
 */
function colourFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return CONTAINER_COLOURS[Math.abs(hash) % CONTAINER_COLOURS.length]!;
}

function surfaceMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  m.diffuseColor = colour;
  // Painted steel: enough specular to catch a highlight, not enough to look wet.
  m.specularColor = new Color3(0.2, 0.21, 0.23);
  m.specularPower = 28;
  // What the surface shows where no light reaches it directly, which in a box yard is most surfaces.
  m.ambientColor = colour.scale(0.85);
  return m;
}

export function buildArena(engine: AbstractEngine, tier: QualityTier): ArenaScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.09, 0.105, 0.14, 1);
  /*
   * Global ambient, multiplied by each material's ambientColor. It sets the floor on how dark an unlit surface can get, and at the
   * original 0.20 that floor was black.
   */
  scene.ambientColor = new Color3(0.34, 0.36, 0.42);
  scene.skipPointerMovePicking = true;

  /*
   * Exponential fog. The cheapest thing that makes a space readable: without it a container 5 units away and one 40 units away are
   * the same brightness and the eye has nothing to judge depth with. It also hides the draw-distance cut on lower tiers.
   *
   * The colour must match the skydome horizon, or distant geometry fades to one colour against a different one and the fog reads as
   * a grey wash rather than as distance.
   */
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(0.07, 0.102, 0.149);

  /*
   * Sky light. Its ground term is the bounce off the yard floor, and without it everything below waist height goes black.
   */
  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.75;
  sky.diffuse = Color3.FromHexString('#b9cbe8');
  sky.groundColor = Color3.FromHexString('#4a5364');

  // The key light, and the only one that casts. Shadows are what make a container sit on the ground rather than hover.
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.35), scene);
  sun.position = new Vector3(30, 46, -30);
  sun.intensity = 1.5;
  sun.diffuse = Color3.FromHexString('#fff4e2');

  /*
   * Two fills, opposite the key and shadowless. With one directional light every face turned away from it received ambient only,
   * which is why containers looked like flat slabs; a fill gives those faces a gradient, and a gradient is what reads as solid.
   *
   * Cool rather than neutral, so the shadow side separates from the sunlit side by hue as well as brightness.
   */
  const fill = new DirectionalLight('fill', new Vector3(0.55, -0.35, -0.5), scene);
  fill.intensity = 0.55;
  fill.diffuse = Color3.FromHexString('#8fb0e0');

  const rim = new DirectionalLight('rim', new Vector3(0.1, 0.4, 0.9), scene);
  rim.intensity = 0.3;
  rim.diffuse = Color3.FromHexString('#a8bcd8');

  // --- Ground ------------------------------------------------------------------------------------

  const floor = MeshBuilder.CreateGround(
    'floor',
    { width: ARENA_HALF * 2, height: ARENA_HALF * 2, subdivisions: 2 },
    scene,
  );
  const grid = new GridMaterial('floorGrid', scene);
  // 5-unit major cells read as yard paving rather than as a technical grid.
  grid.majorUnitFrequency = 5;
  grid.minorUnitVisibility = 0.22;
  grid.gridRatio = 1;
  /*
   * The fill is bright and the lines only slightly brighter. Previously the fill was dark and the lines pale, so the floor read as a
   * glowing net over a void rather than as a lit surface with markings.
   */
  grid.mainColor = Color3.FromHexString('#6b6560');
  grid.lineColor = Color3.FromHexString('#7d766f');
  grid.opacity = 0.99;
  floor.material = grid;
  floor.receiveShadows = true;

  // --- Materials ---------------------------------------------------------------------------------

  const materials: StandardMaterial[] = [];

  /** One material per container colour, shared across every container using it. */
  const containerMaterials = new Map<string, StandardMaterial>();
  for (const hex of CONTAINER_COLOURS) {
    const m = surfaceMaterial(scene, `container-${hex.slice(1)}`, hex);
    containerMaterials.set(hex, m);
    materials.push(m);
  }

  // Timber crates: warmer and rougher than painted steel.
  const crateMaterial = surfaceMaterial(scene, 'crate-timber', '#7d6547');
  crateMaterial.specularColor = new Color3(0.08, 0.075, 0.07);
  materials.push(crateMaterial);

  // Perimeter concrete.
  const wallMaterial = surfaceMaterial(scene, 'yard-wall', '#6e6a66');
  materials.push(wallMaterial);

  /*
   * Upper stacks stay a cool grey rather than taking a container colour. High ground is worth distinguishing from ordinary cover at a
   * glance, and that is gameplay information rather than decoration.
   */
  const platformMaterial = surfaceMaterial(scene, 'yard-platform', '#79808c');
  materials.push(platformMaterial);

  function materialFor(brush: BrushDescriptor): StandardMaterial {
    if (brush.kind === 'wall') return wallMaterial;
    if (brush.kind === 'coverLow') return crateMaterial;
    if (brush.kind === 'platform') return platformMaterial;
    return containerMaterials.get(colourFor(brush.name)) ?? wallMaterial;
  }

  // --- Geometry ----------------------------------------------------------------------------------

  const arenaCasters: Mesh[] = [];
  for (const brush of GREYBOX_BRUSHES) {
    const mesh = MeshBuilder.CreateBox(
      brush.name,
      { width: brush.width, height: brush.height, depth: brush.depth },
      scene,
    );
    mesh.position.set(brush.x, brush.y, brush.z);
    mesh.material = materialFor(brush);
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    // The yard never moves, so its transforms can be computed once.
    mesh.freezeWorldMatrix();
    // Walls do not cast: they are at the arena edge, so their shadows would fall outside it.
    if (brush.kind !== 'wall') arenaCasters.push(mesh);
  }

  /*
   * One emissive strip per wall, near the top, carrying the per-side colour.
   *
   * Two jobs. It suggests the yard is lit from somewhere and stops the upper corners reading as flat black where fog meets shadow.
   * And because the arena is symmetric, the colour tells a player which way they are facing.
   *
   * This is the only light strip in the scene. An earlier version added two more per wall at other heights, and three glowing lines
   * crossing in perspective looked like a rendering fault.
   */
  const stripSpecs = [
    { side: 'north' as const, x: 0, z: ARENA_HALF - 0.6, w: ARENA_HALF * 2, d: 0.12 },
    { side: 'south' as const, x: 0, z: -ARENA_HALF + 0.6, w: ARENA_HALF * 2, d: 0.12 },
    { side: 'east' as const, x: ARENA_HALF - 0.6, z: 0, w: 0.12, d: ARENA_HALF * 2 },
    { side: 'west' as const, x: -ARENA_HALF + 0.6, z: 0, w: 0.12, d: ARENA_HALF * 2 },
  ];

  for (const spec of stripSpecs) {
    const material = new StandardMaterial(`wall-strip-${spec.side}`, scene);
    // Just above 1, so bloom's threshold catches it and it reads as a light source rather than as paint.
    material.emissiveColor = Color3.FromHexString(SIDE_ACCENTS[spec.side]).scale(1.05);
    material.diffuseColor = Color3.Black();
    material.disableLighting = true;
    materials.push(material);

    const strip = MeshBuilder.CreateBox(
      `wall-strip-${spec.side}`,
      { width: spec.w, height: 0.1, depth: spec.d },
      scene,
    );
    strip.position.set(spec.x, WALL_HEIGHT - 0.7, spec.z);
    strip.material = material;
    strip.isPickable = false;
    strip.freezeWorldMatrix();
  }

  // --- Centre beacon -----------------------------------------------------------------------------
  //
  // One landmark, above the centre corridor, visible from anywhere in the yard and the only thing in the scene that moves on its own.
  // Nothing here is solid: it is well above head height and has no collision counterpart in the layout.

  const beaconRoot = new TransformNode('beacon', scene);
  beaconRoot.position.set(0, 7, 0);

  const beaconMaterial = new StandardMaterial('beacon', scene);
  // Above the bloom threshold, because drawing the eye is exactly what a landmark is for.
  beaconMaterial.emissiveColor = Color3.FromHexString('#ffc76b').scale(1.5);
  beaconMaterial.diffuseColor = Color3.Black();
  beaconMaterial.disableLighting = true;
  materials.push(beaconMaterial);

  const beaconMeshes: Mesh[] = [];

  const core = MeshBuilder.CreateIcoSphere('beacon-core', { radius: 0.45, subdivisions: 2 }, scene);
  core.parent = beaconRoot;
  core.material = beaconMaterial;
  core.isPickable = false;
  beaconMeshes.push(core);

  // Two counter-rotating rings. Motion is what separates a landmark from scenery.
  const ringA = MeshBuilder.CreateTorus(
    'beacon-ring-a',
    { diameter: 1.7, thickness: 0.06, tessellation: 28 },
    scene,
  );
  ringA.parent = beaconRoot;
  ringA.material = beaconMaterial;
  ringA.isPickable = false;
  beaconMeshes.push(ringA);

  const ringB = MeshBuilder.CreateTorus(
    'beacon-ring-b',
    { diameter: 2.1, thickness: 0.05, tessellation: 28 },
    scene,
  );
  ringB.parent = beaconRoot;
  ringB.rotation.x = Math.PI / 2;
  ringB.material = beaconMaterial;
  ringB.isPickable = false;
  beaconMeshes.push(ringB);

  /**
   * Camera position and orientation are written every frame by the CameraRig from the interpolated snapshot, so it carries no
   * controls of its own.
   */
  const camera = new FreeCamera('view', new Vector3(0, 1.65, -ARENA_HALF + 3), scene);
  camera.minZ = 0.08;
  camera.fov = 1.25;

  let shadows: ShadowGenerator | null = null;
  /** Casters registered by other systems, replayed onto a rebuilt generator. */
  const externalCasters: Mesh[] = [];
  let beaconEnabled = true;

  
function applyTier(next: QualityTier): void {
    scene.fogDensity = next.fogDensity;
    camera.maxZ = next.drawDistance;

    // The beacon is the only animated node in the scene, so it is the first thing to drop on Low.
    beaconEnabled = next.name !== 'low';
    beaconRoot.setEnabled(beaconEnabled);

    /*
     * A ShadowGenerator's map size is fixed when it is constructed, so changing tier means disposing and rebuilding. Acceptable
     * because tier changes happen from a menu, not mid-fight.
     */
    const wantSize = next.shadowMapSize;
    const currentSize = shadows?.mapSize ?? 0;
    if (wantSize !== currentSize) {
      shadows?.dispose();
      shadows = null;
      if (wantSize > 0) {
        shadows = new ShadowGenerator(wantSize, sun);
        /*
         * Lighter than a typical default. With fill lights present, a very dark shadow implies no bounce light at all and reads as a
         * hole in the ground rather than as shade.
         */
        shadows.darkness = 0.3;
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

    update(now: number) {
      if (!beaconEnabled) return;
      const seconds = now / 1000;
      // Slow: a fast spin would pull the eye away from enemies, which is a gameplay cost rather than a visual one.
      ringA.rotation.y = seconds * 0.5;
      ringB.rotation.z = -seconds * 0.35;
      beaconRoot.position.y = 7 + Math.sin(seconds * 0.8) * 0.14;
    },

    addShadowCasters(meshes: Mesh[]) {
      for (const mesh of meshes) {
        /*
         * Guard against re-registering. The shadow registrar re-syncs whenever the figure pool changes, so without this a long
         * session accumulates duplicate entries for the same mesh.
         */
        if (externalCasters.includes(mesh)) continue;
        externalCasters.push(mesh);
        shadows?.addShadowCaster(mesh);
      }
    },

    dispose() {
      shadows?.dispose();
      for (const mesh of beaconMeshes) mesh.dispose();
      beaconRoot.dispose();
      for (const material of materials) material.dispose();
      scene.dispose();
    },
  };
}
