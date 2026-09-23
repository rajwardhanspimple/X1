/**
 * Greybox arena.
 *
 * Geometry is generated from GREYBOX_BRUSHES in @rearena/sim, the same list the simulation turns
 * into collision boxes. When the renderer declared its own boxes there was nothing stopping the two
 * from drifting, and a mismatch shows up as an invisible wall or cover you can shoot through.
 *
 * ## Lighting, and why it was wrong
 *
 * The arena used to render as black boxes with glowing lines. The surfaces were always too dark and
 * nothing forced the issue until emissive decoration was added next to them: #252b38 is 14% grey, and
 * under one hemispheric light at 0.42 plus a single directional it lands near black. ACES tone mapping
 * then compressed the midtones further, so the change meant to improve the look is what exposed it.
 *
 * Three rules came out of that, and they are worth keeping:
 *
 * A surface colour that looks right as a swatch is usually far too dark once it is only lit
 * indirectly. Pick the value you want to SEE, not the value that sounds moody.
 *
 * One directional light means every face turned away from it is lit by ambient alone, which is how
 * cover boxes became featureless slabs. Fill lights opposite the key cost nothing (no shadow map, no
 * extra draw call) and are what give geometry its shape.
 *
 * In a scene lit from above, bounce off the floor is not optional. Without a raised hemispheric ground
 * term, everything below waist height goes black.
 *
 * ## One light strip per wall
 *
 * The wall strips live here and nowhere else. decor.ts briefly added its own at eye height and at floor
 * level, which gave every wall three glowing lines at three heights; in perspective they crossed each
 * other and the wall edges, and read as stray lines through the arena rather than as lighting.
 *
 * They carry the per-side colour, so the orientation cue costs no extra geometry.
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
import { SIDE_ACCENTS } from './decor.js';
import type { QualityTier } from './quality.js';

export interface ArenaScene {
  scene: Scene;
  camera: FreeCamera;
  /** Apply a tier mid-session. Shadows are rebuilt because map size is fixed at construction. */
  applyTier(tier: QualityTier): void;
  addShadowCasters(meshes: Mesh[]): void;
  dispose(): void;
}


/**
 * Surface colour per brush kind.
 *
 * Roughly three times brighter than the original values, and deliberately different in HUE rather than
 * four shades of the same navy: walls read as concrete, cover as painted steel, platforms as a lighter
 * deck. Distinguishing cover from walls at a glance is gameplay information, not decoration.
 */
const BRUSH_COLOURS: Record<BrushDescriptor['kind'], string> = {
  wall: '#6b7383',
  coverLow: '#7d8798',
  coverHigh: '#8a94a6',
  platform: '#737d8e',
};


function surfaceMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  m.diffuseColor = colour;
  /*
   * Raised from 0.08. A surface with almost no specular has no highlight to catch, so in a dimly lit
   * scene it has nothing at all to define its shape and reads as a flat silhouette.
   */
  m.specularColor = new Color3(0.22, 0.23, 0.26);
  m.specularPower = 32;
  /*
   * Ambient at 0.85 of the diffuse colour, up from 0.5. This is what a surface shows when no light
   * reaches it directly, which in a box arena is most surfaces most of the time.
   */
  m.ambientColor = colour.scale(0.85);
  return m;
}

export function buildArena(engine: AbstractEngine, tier: QualityTier): ArenaScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.09, 0.105, 0.14, 1);
  /*
   * Global ambient, up from 0.20. Multiplied by each material's ambientColor, so it sets the floor on
   * how dark an unlit surface can get. At 0.20 that floor was black.
   */
  scene.ambientColor = new Color3(0.34, 0.36, 0.42);
  scene.skipPointerMovePicking = true;

  /*
   * Exponential fog. The cheapest thing that makes a space readable: without it, a wall 5 units away
   * and one 40 units away are the same brightness and the eye has nothing to judge depth with. It
   * also hides the draw-distance cut on lower tiers, which would otherwise be a hard edge.
   *
   * The colour must match the skydome horizon, or distant geometry fades to one colour against a
   * different one and the fog reads as a grey wash rather than as distance.
   */
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(0.07, 0.102, 0.149);

  /*
   * Sky light. Up from 0.42, and its ground term is much brighter: that term is the bounce off the
   * floor, and without it everything below waist height in an overhead-lit arena goes black.
   */
  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.75;
  sky.diffuse = Color3.FromHexString('#b9cbe8');
  sky.groundColor = Color3.FromHexString('#4a5364');

  // The key light, and the only one that casts. Shadows are what make an object sit on the floor
  // rather than hover above it.
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.35), scene);
  sun.position = new Vector3(26, 42, -26);
  sun.intensity = 1.5;
  sun.diffuse = Color3.FromHexString('#fff4e2');

  /*
   * Two fills, opposite the key and shadowless.
   *
   * With one directional light every face turned away from it received ambient only, which is why the
   * cover boxes looked like flat slabs. A fill from the opposite side gives those faces a gradient, and
   * a gradient is what the eye reads as a solid object.
   *
   * Cool rather than neutral, so the shadow side separates from the sunlit side by hue as well as by
   * brightness. Cheap: no shadow map, no extra geometry, no extra draw call.
   */
  const fill = new DirectionalLight('fill', new Vector3(0.55, -0.35, -0.5), scene);
  fill.intensity = 0.55;
  fill.diffuse = Color3.FromHexString('#8fb0e0');

  const rim = new DirectionalLight('rim', new Vector3(0.1, 0.4, 0.9), scene);
  rim.intensity = 0.3;
  rim.diffuse = Color3.FromHexString('#a8bcd8');

  const floor = MeshBuilder.CreateGround(
    'floor',
    { width: ARENA_HALF * 2, height: ARENA_HALF * 2, subdivisions: 2 },
    scene,
  );
  const grid = new GridMaterial('floorGrid', scene);
  grid.majorUnitFrequency = 5;
  // Softer minor lines: at 0.45 the grid read as a wireframe rather than as markings on a surface.
  grid.minorUnitVisibility = 0.25;
  grid.gridRatio = 1;
  /*
   * The fill is much brighter and the lines only slightly brighter than it. Previously the fill was dark
   * and the lines pale, so the floor read as a glowing net over a void instead of as a lit floor.
   */
  grid.mainColor = Color3.FromHexString('#6e7889');
  grid.lineColor = Color3.FromHexString('#828da1');
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
   * One emissive strip per wall, near the top.
   *
   * Two jobs. It gives the arena a sense of being lit from somewhere and stops the upper corners reading
   * as flat black where fog and shadow meet. And it carries the per-side colour, so a player who spins
   * around can tell which way they are facing in a perfectly symmetric arena.
   *
   * This is the ONLY light strip in the scene. decor.ts briefly added two more per wall, and three
   * glowing lines at three heights crossed each other in perspective and looked like a fault.
   */
  const stripSpecs: Array<{
    side: keyof typeof SIDE_ACCENTS;
    x: number;
    z: number;
    w: number;
    d: number;
  }> = [
    { side: 'north', x: 0, z: ARENA_HALF - 0.6, w: ARENA_HALF * 2, d: 0.12 },
    { side: 'south', x: 0, z: -ARENA_HALF + 0.6, w: ARENA_HALF * 2, d: 0.12 },
    { side: 'east', x: ARENA_HALF - 0.6, z: 0, w: 0.12, d: ARENA_HALF * 2 },
    { side: 'west', x: -ARENA_HALF + 0.6, z: 0, w: 0.12, d: ARENA_HALF * 2 },
  ];

  const stripMaterials: StandardMaterial[] = [];
  for (const spec of stripSpecs) {
    const material = new StandardMaterial(`wall-strip-${spec.side}`, scene);
    /*
     * Just above 1, so bloom's threshold catches it and it reads as a light source. Much lower than the
     * 1.8 the decor strips used: against properly lit walls, that was blinding.
     */
    material.emissiveColor = Color3.FromHexString(SIDE_ACCENTS[spec.side]).scale(1.05);
    material.diffuseColor = Color3.Black();
    material.disableLighting = true;
    stripMaterials.push(material);

    const strip = MeshBuilder.CreateBox(
      `wall-strip-${spec.side}`,
      { width: spec.w, height: 0.1, depth: spec.d },
      scene,
    );
    strip.position.set(spec.x, WALL_HEIGHT - 0.5, spec.z);
    strip.material = material;
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
        /*
         * Lighter than the original 0.45. With fill lights present, a shadow that dark implies no bounce
         * light at all and reads as a hole in the floor rather than as shade.
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
    addShadowCasters(meshes: Mesh[]) {
      for (const mesh of meshes) {
        /*
         * Guard against re-registering. The shadow registrar re-syncs whenever the figure pool changes,
         * so without this a long session accumulates duplicate entries for the same mesh.
         */
        if (externalCasters.includes(mesh)) continue;
        externalCasters.push(mesh);
        shadows?.addShadowCaster(mesh);
      }
    },
    dispose() {
      shadows?.dispose();
      for (const material of stripMaterials) material.dispose();
      scene.dispose();
    },
  };
}
