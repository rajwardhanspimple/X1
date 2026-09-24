/**
 * Arena renderer.
 *
 * Solids come only from ArenaMap.brushes. Decoration stays non-solid and anchored to those brushes,
 * so the renderer can give each map a readable identity without creating collision the simulation
 * does not own.
 */

import { getArenaMap, type ArenaMap, type MapBrush } from '@rearena/sim';
import { Scene } from '@babylonjs/core/scene.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { QualityTier } from './quality.js';

export interface ArenaScene {
  scene: Scene;
  camera: FreeCamera;
  applyTier(tier: QualityTier): void;
  setMap(map: ArenaMap): void;
  addShadowCasters(meshes: Mesh[]): void;
  update(now: number): void;
  dispose(): void;
}

type SurfaceFamily =
  | 'wall'
  | 'container'
  | 'crate'
  | 'platform'
  | 'sandbag'
  | 'concrete'
  | 'building'
  | 'vehicle'
  | 'metal';

type Toggleable = { setEnabled(enabled: boolean): void };

interface FloorStyle {
  main: string;
  line: string;
  major: number;
  minor: number;
  opacity: number;
}

interface ThemePalette {
  floor: FloorStyle;
  wall: string;
  platform: string;
  crate: string;
  crateTrim: string;
  concrete: string;
  concreteTrim: string;
  metal: string;
  metalTrim: string;
  sandbag: string;
  sandbagTrim: string;
  building: string;
  buildingTrim: string;
  vehicle: string;
  vehicleTrim: string;
  windows: string;
  lamp: string;
  mast: string;
  beacon: string;
}

interface MapRuntime {
  shadowCasters: Mesh[];
  applyTier(tier: QualityTier): void;
  update(now: number): void;
  dispose(): void;
}

const CONTAINER_COLOURS = [
  '#8c4a3f',
  '#3f6b8c',
  '#4a7c59',
  '#8c7a3f',
  '#5e5a56',
  '#7a6a5d',
] as const;

const SIDE_ACCENTS = {
  north: '#4f8ce0',
  south: '#4fe0a9',
  east: '#e0d24f',
  west: '#9d4fe0',
} as const;

const DEFAULT_MAP_ID = 'container-yard';
const CONTAINER_W = 2.4;
const EYE_HEIGHT = 1.65;

const THEME_PALETTES: Record<ArenaMap['theme'], ThemePalette> = {
  yard: {
    floor: { main: '#6b6560', line: '#7d766f', major: 5, minor: 0.22, opacity: 0.99 },
    wall: '#6e6a66',
    platform: '#79808c',
    crate: '#7d6547',
    crateTrim: '#634f39',
    concrete: '#6e6a66',
    concreteTrim: '#5b5754',
    metal: '#59626d',
    metalTrim: '#434a53',
    sandbag: '#8b7d62',
    sandbagTrim: '#75694f',
    building: '#66707a',
    buildingTrim: '#515963',
    vehicle: '#59615d',
    vehicleTrim: '#424844',
    windows: '#93b5d8',
    lamp: '#cfe4ff',
    mast: '#3a3f47',
    beacon: '#ffc76b',
  },
  outpost: {
    floor: { main: '#756b57', line: '#867b65', major: 6, minor: 0.18, opacity: 0.99 },
    wall: '#7b736b',
    platform: '#707982',
    crate: '#7d6547',
    crateTrim: '#634f39',
    concrete: '#7c776f',
    concreteTrim: '#67625b',
    metal: '#5a636c',
    metalTrim: '#424b53',
    sandbag: '#8d7e62',
    sandbagTrim: '#75694f',
    building: '#7a756d',
    buildingTrim: '#635f59',
    vehicle: '#59615d',
    vehicleTrim: '#424844',
    windows: '#8fb0d0',
    lamp: '#d7e5f3',
    mast: '#454b53',
    beacon: '#ffc76b',
  },
  urban: {
    floor: { main: '#4c5158', line: '#60656d', major: 6, minor: 0.16, opacity: 0.99 },
    wall: '#686e76',
    platform: '#747b84',
    crate: '#745c44',
    crateTrim: '#5f4a35',
    concrete: '#6f757d',
    concreteTrim: '#595f67',
    metal: '#59626c',
    metalTrim: '#414953',
    sandbag: '#887a60',
    sandbagTrim: '#6d624d',
    building: '#626a73',
    buildingTrim: '#4e555d',
    vehicle: '#5c635b',
    vehicleTrim: '#424844',
    windows: '#b8cbe0',
    lamp: '#d7e1ef',
    mast: '#454b53',
    beacon: '#ffc76b',
  },
};

function colourFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return CONTAINER_COLOURS[Math.abs(hash) % CONTAINER_COLOURS.length]!;
}

function surfaceMaterial(scene: Scene, name: string, hex: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  const colour = Color3.FromHexString(hex);
  material.diffuseColor = colour;
  material.specularColor = new Color3(0.2, 0.21, 0.23);
  material.specularPower = 28;
  material.ambientColor = colour.scale(0.85);
  return material;
}

function emissiveMaterial(
  scene: Scene,
  name: string,
  hex: string,
  intensity: number,
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.emissiveColor = Color3.FromHexString(hex).scale(intensity);
  material.diffuseColor = Color3.Black();
  material.disableLighting = true;
  return material;
}

function isStairBrush(brush: MapBrush): boolean {
  return /(?:^|[-_])(?:s\d+|g\d+|step|steps|stair|stairs)(?:$|[-_])/i.test(brush.name);
}

function fogDensityFor(tier: QualityTier, map: ArenaMap): number {
  const referenceSize = 64;
  return tier.fogDensity * Math.min(1, referenceSize / (map.halfSize * 2));
}

function farPlaneFor(tier: QualityTier, map: ArenaMap): number {
  return Math.max(tier.drawDistance, map.halfSize * 2.5);
}

function positionSun(sun: DirectionalLight, map: ArenaMap): void {
  sun.position.set(map.halfSize * 0.94, Math.max(46, map.halfSize * 0.85), -map.halfSize * 0.94);
  sun.shadowFrustumSize = map.halfSize * 2.6;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = Math.max(96, map.halfSize * 3.2);
}

function firstSpawn(map: ArenaMap): { x: number; y: number; z: number; yaw: number } {
  const spawn = map.spawns[0];
  if (spawn) return { x: spawn.x, y: spawn.y ?? 0, z: spawn.z, yaw: spawn.yaw };
  return { x: 0, y: 0, z: -map.halfSize + 3, yaw: 0 };
}

function applySpawnCamera(camera: FreeCamera, map: ArenaMap): void {
  const spawn = firstSpawn(map);
  const eyeY = spawn.y + EYE_HEIGHT;
  const yawRad = spawn.yaw * Math.PI * 2;
  camera.position.set(spawn.x, eyeY, spawn.z);
  camera.setTarget(new Vector3(spawn.x + Math.sin(yawRad), eyeY, spawn.z + Math.cos(yawRad)));
  camera.rotation.z = 0;
}

function createMapRuntime(scene: Scene, map: ArenaMap): MapRuntime {
  const palette = THEME_PALETTES[map.theme];
  const materials: Array<{ dispose(): void }> = [];
  const meshes: Mesh[] = [];
  const nodes: TransformNode[] = [];
  const lights: PointLight[] = [];
  const optionalTargets: Toggleable[] = [];
  const shadowCasters: Mesh[] = [];

  let beaconRoot: TransformNode | null = null;
  let ringA: Mesh | null = null;
  let ringB: Mesh | null = null;
  let beaconBaseY = 0;
  let showOptional = true;

  const keepMaterial = <T extends { dispose(): void }>(material: T): T => {
    materials.push(material);
    return material;
  };

  const keepStaticMesh = (mesh: Mesh, optional = false): Mesh => {
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.freezeWorldMatrix();
    meshes.push(mesh);
    if (optional) optionalTargets.push(mesh);
    return mesh;
  };

  const keepDynamicMesh = (mesh: Mesh, optional = false): Mesh => {
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    meshes.push(mesh);
    if (optional) optionalTargets.push(mesh);
    return mesh;
  };

  const keepNode = (node: TransformNode, optional = false): TransformNode => {
    nodes.push(node);
    if (optional) optionalTargets.push(node);
    return node;
  };

  const keepLight = (light: PointLight, optional = false): PointLight => {
    lights.push(light);
    if (optional) optionalTargets.push(light);
    return light;
  };

  const floor = MeshBuilder.CreateGround(
    `${map.id}-floor`,
    {
      width: map.halfSize * 2,
      height: map.halfSize * 2,
      subdivisions: Math.max(2, Math.round(map.halfSize / 24)),
    },
    scene,
  );
  const grid = keepMaterial(new GridMaterial(`${map.id}-floor-grid`, scene));
  grid.majorUnitFrequency = palette.floor.major;
  grid.minorUnitVisibility = palette.floor.minor;
  grid.gridRatio = 1;
  grid.mainColor = Color3.FromHexString(palette.floor.main);
  grid.lineColor = Color3.FromHexString(palette.floor.line);
  grid.opacity = palette.floor.opacity;
  floor.material = grid;
  floor.receiveShadows = true;
  keepStaticMesh(floor);

  const containerMaterials = new Map<string, StandardMaterial>();
  for (const hex of CONTAINER_COLOURS) {
    containerMaterials.set(
      hex,
      keepMaterial(surfaceMaterial(scene, `${map.id}-container-${hex.slice(1)}`, hex)),
    );
  }

  const containerRibMaterials = new Map<string, StandardMaterial>();
  for (const hex of CONTAINER_COLOURS) {
    const material = keepMaterial(
      new StandardMaterial(`${map.id}-container-rib-${hex.slice(1)}`, scene),
    );
    const colour = Color3.FromHexString(hex).scale(0.78);
    material.diffuseColor = colour;
    material.specularColor = new Color3(0.16, 0.17, 0.19);
    material.specularPower = 28;
    material.ambientColor = colour.scale(0.85);
    containerRibMaterials.set(hex, material);
  }

  const wallMaterial = keepMaterial(surfaceMaterial(scene, `${map.id}-wall`, palette.wall));
  const platformMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-platform`, palette.platform),
  );
  const crateMaterial = keepMaterial(surfaceMaterial(scene, `${map.id}-crate`, palette.crate));
  crateMaterial.specularColor = new Color3(0.08, 0.075, 0.07);
  const crateTrimMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-crate-trim`, palette.crateTrim),
  );
  crateTrimMaterial.specularColor = new Color3(0.08, 0.075, 0.07);
  const concreteMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-concrete`, palette.concrete),
  );
  const concreteTrimMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-concrete-trim`, palette.concreteTrim),
  );
  const metalMaterial = keepMaterial(surfaceMaterial(scene, `${map.id}-metal`, palette.metal));
  const metalTrimMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-metal-trim`, palette.metalTrim),
  );
  const sandbagMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-sandbag`, palette.sandbag),
  );
  sandbagMaterial.specularColor = new Color3(0.05, 0.05, 0.05);
  const sandbagTrimMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-sandbag-trim`, palette.sandbagTrim),
  );
  sandbagTrimMaterial.specularColor = new Color3(0.04, 0.04, 0.04);
  const buildingMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-building`, palette.building),
  );
  const buildingTrimMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-building-trim`, palette.buildingTrim),
  );
  const vehicleMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-vehicle`, palette.vehicle),
  );
  const vehicleTrimMaterial = keepMaterial(
    surfaceMaterial(scene, `${map.id}-vehicle-trim`, palette.vehicleTrim),
  );
  const windowMaterial = keepMaterial(
    emissiveMaterial(scene, `${map.id}-windows`, palette.windows, 0.55),
  );
  windowMaterial.alpha = 0.92;
  const mastMaterial = keepMaterial(surfaceMaterial(scene, `${map.id}-mast`, palette.mast));
  mastMaterial.specularColor = new Color3(0.3, 0.3, 0.32);
  mastMaterial.specularPower = 48;
  const lampMaterial = keepMaterial(emissiveMaterial(scene, `${map.id}-lamp`, palette.lamp, 1.35));
  const beaconMaterial = keepMaterial(
    emissiveMaterial(scene, `${map.id}-beacon`, palette.beacon, 1.5),
  );

  const materialFamilyFor = (brush: MapBrush): SurfaceFamily => {
    if (brush.surface) return brush.surface;

    if (map.theme === 'yard') {
      if (brush.kind === 'wall') return 'wall';
      if (brush.kind === 'coverLow') return 'crate';
      if (brush.kind === 'platform') return 'platform';
      return 'container';
    }

    if (map.theme === 'outpost') {
      if (brush.kind === 'wall') return 'concrete';
      if (isStairBrush(brush)) return 'metal';
      if (brush.kind === 'platform') return 'metal';
      return 'sandbag';
    }

    if (brush.kind === 'wall') return 'concrete';
    if (isStairBrush(brush)) return 'concrete';
    if (brush.kind === 'platform') return 'concrete';
    if (brush.kind === 'coverHigh') return 'building';
    return 'concrete';
  };

  const solidMaterialFor = (brush: MapBrush): StandardMaterial => {
    switch (materialFamilyFor(brush)) {
      case 'wall':
        return wallMaterial;
      case 'crate':
        return crateMaterial;
      case 'platform':
        return platformMaterial;
      case 'sandbag':
        return sandbagMaterial;
      case 'concrete':
        return concreteMaterial;
      case 'building':
        return buildingMaterial;
      case 'vehicle':
        return vehicleMaterial;
      case 'metal':
        return metalMaterial;
      case 'container':
      default:
        return containerMaterials.get(colourFor(brush.name)) ?? wallMaterial;
    }
  };

  const addTopFrame = (
    brush: MapBrush,
    material: StandardMaterial,
    thickness = 0.08,
    lift = 0.05,
  ): void => {
    const top = brush.y + brush.height / 2 + lift;
    const strips = [
      { width: brush.width + 0.02, depth: thickness, ox: 0, oz: brush.depth / 2 },
      { width: brush.width + 0.02, depth: thickness, ox: 0, oz: -brush.depth / 2 },
      { width: thickness, depth: brush.depth + 0.02, ox: brush.width / 2, oz: 0 },
      { width: thickness, depth: brush.depth + 0.02, ox: -brush.width / 2, oz: 0 },
    ] as const;

    for (const strip of strips) {
      const frame = MeshBuilder.CreateBox(
        `${map.id}-${brush.name}-frame-${strip.ox.toFixed(2)}-${strip.oz.toFixed(2)}`,
        { width: strip.width, height: thickness, depth: strip.depth },
        scene,
      );
      frame.position.set(brush.x + strip.ox, top, brush.z + strip.oz);
      frame.material = material;
      keepStaticMesh(frame, true);
    }
  };

  const addContainerDetail = (brush: MapBrush): void => {
    const colour = colourFor(brush.name);
    const ribMaterial = containerRibMaterials.get(colour) ?? wallMaterial;
    const long = Math.max(brush.width, brush.depth);
    const alongX = brush.width >= brush.depth;
    const ribCount = Math.max(2, Math.floor(long / 0.8));

    for (let i = 1; i < ribCount; i++) {
      const offset = -long / 2 + (long / ribCount) * i;
      const rib = MeshBuilder.CreateBox(
        `${map.id}-${brush.name}-rib-${i}`,
        alongX
          ? { width: 0.1, height: brush.height * 0.96, depth: brush.depth + 0.04 }
          : { width: brush.width + 0.04, height: brush.height * 0.96, depth: 0.1 },
        scene,
      );
      rib.position.set(brush.x + (alongX ? offset : 0), brush.y, brush.z + (alongX ? 0 : offset));
      rib.material = ribMaterial;
      keepStaticMesh(rib, true);
    }

    const halfLong = long / 2;
    for (const end of [-halfLong + 0.09, halfLong - 0.09]) {
      for (const side of [-CONTAINER_W / 2 - 0.02, CONTAINER_W / 2 + 0.02]) {
        const post = MeshBuilder.CreateBox(
          `${map.id}-${brush.name}-post-${end.toFixed(2)}-${side.toFixed(2)}`,
          { width: 0.14, height: brush.height, depth: 0.14 },
          scene,
        );
        post.position.set(
          brush.x + (alongX ? end : side),
          brush.y,
          brush.z + (alongX ? side : end),
        );
        post.material = ribMaterial;
        keepStaticMesh(post, true);
      }
    }
  };

  const addCrateDetail = (brush: MapBrush): void => {
    const top = brush.y + brush.height / 2;
    const bands = [
      { width: brush.width + 0.02, depth: 0.08, ox: 0, oz: brush.depth / 2 },
      { width: brush.width + 0.02, depth: 0.08, ox: 0, oz: -brush.depth / 2 },
      { width: 0.08, depth: brush.depth + 0.02, ox: brush.width / 2, oz: 0 },
      { width: 0.08, depth: brush.depth + 0.02, ox: -brush.width / 2, oz: 0 },
    ] as const;

    for (const bandSpec of bands) {
      const band = MeshBuilder.CreateBox(
        `${map.id}-${brush.name}-band-${bandSpec.ox.toFixed(2)}-${bandSpec.oz.toFixed(2)}`,
        { width: bandSpec.width, height: 0.1, depth: bandSpec.depth },
        scene,
      );
      band.position.set(brush.x + bandSpec.ox, top, brush.z + bandSpec.oz);
      band.material = crateTrimMaterial;
      keepStaticMesh(band, true);
    }
  };

  const addSandbagDetail = (brush: MapBrush): void => {
    const alongX = brush.width >= brush.depth;
    const short = alongX ? brush.depth : brush.width;
    const baseY = brush.y - brush.height / 2;
    const seamY = baseY + Math.min(brush.height * 0.45, 0.45);

    for (const side of [-1, 1] as const) {
      const seam = MeshBuilder.CreateBox(
        `${map.id}-${brush.name}-sandbag-seam-${side}`,
        alongX
          ? { width: brush.width * 0.94, height: 0.08, depth: 0.08 }
          : { width: 0.08, height: 0.08, depth: brush.depth * 0.94 },
        scene,
      );
      seam.position.set(
        brush.x + (alongX ? 0 : side * (short / 2 + 0.02)),
        seamY,
        brush.z + (alongX ? side * (short / 2 + 0.02) : 0),
      );
      seam.material = sandbagTrimMaterial;
      keepStaticMesh(seam, true);
    }

    const crown = MeshBuilder.CreateBox(
      `${map.id}-${brush.name}-sandbag-crown`,
      alongX
        ? { width: brush.width * 0.9, height: 0.12, depth: 0.22 }
        : { width: 0.22, height: 0.12, depth: brush.depth * 0.9 },
      scene,
    );
    crown.position.set(brush.x, brush.y + brush.height / 2 - 0.06, brush.z);
    crown.material = sandbagTrimMaterial;
    keepStaticMesh(crown, true);
  };

  const addConcreteDetail = (brush: MapBrush): void => {
    addTopFrame(brush, concreteTrimMaterial);

    if (brush.height < 2.5) return;

    const alongX = brush.width >= brush.depth;
    const short = alongX ? brush.depth : brush.width;
    const baseY = brush.y - brush.height / 2;
    const revealY = baseY + Math.min(brush.height * 0.32, 1.2);

    for (const side of [-1, 1] as const) {
      const reveal = MeshBuilder.CreateBox(
        `${map.id}-${brush.name}-concrete-reveal-${side}`,
        alongX
          ? { width: brush.width * 0.94, height: 0.08, depth: 0.08 }
          : { width: 0.08, height: 0.08, depth: brush.depth * 0.94 },
        scene,
      );
      reveal.position.set(
        brush.x + (alongX ? 0 : side * (short / 2 + 0.02)),
        revealY,
        brush.z + (alongX ? side * (short / 2 + 0.02) : 0),
      );
      reveal.material = concreteTrimMaterial;
      keepStaticMesh(reveal, true);
    }
  };

  const addMetalDetail = (brush: MapBrush): void => {
    addTopFrame(brush, metalTrimMaterial, 0.07, 0.04);

    if (brush.height < 1.2) return;

    for (const xSide of [-1, 1] as const) {
      for (const zSide of [-1, 1] as const) {
        const post = MeshBuilder.CreateBox(
          `${map.id}-${brush.name}-metal-post-${xSide}-${zSide}`,
          { width: 0.08, height: brush.height + 0.08, depth: 0.08 },
          scene,
        );
        post.position.set(
          brush.x + xSide * (brush.width / 2 - 0.08),
          brush.y,
          brush.z + zSide * (brush.depth / 2 - 0.08),
        );
        post.material = metalTrimMaterial;
        keepStaticMesh(post, true);
      }
    }
  };

  const addBuildingDetail = (brush: MapBrush): void => {
    addTopFrame(brush, buildingTrimMaterial, 0.08, 0.04);

    if (brush.height < 5 || (brush.width < 5 && brush.depth < 5)) return;

    const alongX = brush.width >= brush.depth;
    const long = alongX ? brush.width : brush.depth;
    const short = alongX ? brush.depth : brush.width;
    const rows = Math.min(2, Math.max(1, Math.floor((brush.height - 2) / 2.8)));
    const cols = Math.min(2, Math.max(1, Math.floor(long / 7)));
    const yBase = brush.y - brush.height / 2 + 2;

    for (const side of [-1, 1] as const) {
      for (let row = 0; row < rows; row++) {
        const y = yBase + row * 2.35;
        for (let col = 0; col < cols; col++) {
          const offset = cols === 1 ? 0 : col === 0 ? -long * 0.22 : long * 0.22;
          const windowBox = MeshBuilder.CreateBox(
            `${map.id}-${brush.name}-window-${side}-${row}-${col}`,
            alongX
              ? { width: 1.4, height: 0.9, depth: 0.08 }
              : { width: 0.08, height: 0.9, depth: 1.4 },
            scene,
          );
          windowBox.position.set(
            brush.x + (alongX ? offset : side * (short / 2 + 0.03)),
            y,
            brush.z + (alongX ? side * (short / 2 + 0.03) : offset),
          );
          windowBox.material = windowMaterial;
          keepStaticMesh(windowBox, true);
        }
      }
    }
  };

  const addVehicleDetail = (brush: MapBrush): void => {
    addTopFrame(brush, vehicleTrimMaterial, 0.07, 0.03);

    const alongX = brush.width >= brush.depth;
    const baseY = brush.y - brush.height / 2;

    const skirt = MeshBuilder.CreateBox(
      `${map.id}-${brush.name}-vehicle-skirt`,
      alongX
        ? { width: brush.width * 0.96, height: 0.12, depth: brush.depth + 0.03 }
        : { width: brush.width + 0.03, height: 0.12, depth: brush.depth * 0.96 },
      scene,
    );
    skirt.position.set(brush.x, baseY + 0.18, brush.z);
    skirt.material = vehicleTrimMaterial;
    keepStaticMesh(skirt, true);

    if (brush.height < 1.4) return;

    const glass = MeshBuilder.CreateBox(
      `${map.id}-${brush.name}-vehicle-glass`,
      alongX
        ? { width: 0.08, height: Math.max(0.6, brush.height * 0.42), depth: brush.depth * 0.72 }
        : { width: brush.width * 0.72, height: Math.max(0.6, brush.height * 0.42), depth: 0.08 },
      scene,
    );
    glass.position.set(
      brush.x + (alongX ? brush.width / 2 - 0.08 : 0),
      brush.y + brush.height * 0.08,
      brush.z + (alongX ? 0 : brush.depth / 2 - 0.08),
    );
    glass.material = windowMaterial;
    keepStaticMesh(glass, true);
  };

  const decorateBrush = (brush: MapBrush): void => {
    const family = materialFamilyFor(brush);

    if (map.theme === 'yard') {
      if (family === 'container' && brush.kind === 'coverHigh') addContainerDetail(brush);
      else if (family === 'crate' && brush.kind === 'coverLow') addCrateDetail(brush);
      return;
    }

    switch (family) {
      case 'sandbag':
        addSandbagDetail(brush);
        break;
      case 'concrete':
        addConcreteDetail(brush);
        break;
      case 'metal':
        addMetalDetail(brush);
        break;
      case 'building':
        addBuildingDetail(brush);
        break;
      case 'vehicle':
        addVehicleDetail(brush);
        break;
      case 'crate':
        addCrateDetail(brush);
        break;
      case 'platform':
        addConcreteDetail(brush);
        break;
      default:
        break;
    }
  };

  for (const brush of map.brushes) {
    const mesh = MeshBuilder.CreateBox(
      `${map.id}-${brush.name}`,
      { width: brush.width, height: brush.height, depth: brush.depth },
      scene,
    );
    mesh.position.set(brush.x, brush.y, brush.z);
    mesh.material = solidMaterialFor(brush);
    mesh.receiveShadows = true;
    keepStaticMesh(mesh);

    if (brush.kind !== 'wall') shadowCasters.push(mesh);
    decorateBrush(brush);
  }

  const stripSpecs = [
    { side: 'north' as const, x: 0, z: map.halfSize - 0.6, width: map.halfSize * 2, depth: 0.12 },
    { side: 'south' as const, x: 0, z: -map.halfSize + 0.6, width: map.halfSize * 2, depth: 0.12 },
    { side: 'east' as const, x: map.halfSize - 0.6, z: 0, width: 0.12, depth: map.halfSize * 2 },
    { side: 'west' as const, x: -map.halfSize + 0.6, z: 0, width: 0.12, depth: map.halfSize * 2 },
  ];

  for (const spec of stripSpecs) {
    const stripMaterial = keepMaterial(
      emissiveMaterial(scene, `${map.id}-wall-strip-${spec.side}`, SIDE_ACCENTS[spec.side], 1.05),
    );
    const strip = MeshBuilder.CreateBox(
      `${map.id}-wall-strip-${spec.side}`,
      { width: spec.width, height: 0.1, depth: spec.depth },
      scene,
    );
    strip.position.set(spec.x, Math.max(0.75, map.wallHeight - 0.7), spec.z);
    strip.material = stripMaterial;
    keepStaticMesh(strip, true);
  }

  if (map.theme === 'yard') {
    const mastInset = Math.max(3, Math.min(5, map.halfSize * 0.12));
    const mastHeight = map.wallHeight * 1.3;

    for (const [mx, mz] of [
      [map.halfSize - mastInset, map.halfSize - mastInset],
      [-(map.halfSize - mastInset), map.halfSize - mastInset],
      [map.halfSize - mastInset, -(map.halfSize - mastInset)],
      [-(map.halfSize - mastInset), -(map.halfSize - mastInset)],
    ] as const) {
      const mast = MeshBuilder.CreateCylinder(
        `${map.id}-mast-${mx.toFixed(1)}-${mz.toFixed(1)}`,
        { diameter: 0.22, height: mastHeight, tessellation: 8 },
        scene,
      );
      mast.position.set(mx, mastHeight / 2, mz);
      mast.material = mastMaterial;
      keepStaticMesh(mast, true);

      const lampHead = MeshBuilder.CreateBox(
        `${map.id}-mast-lamp-${mx.toFixed(1)}-${mz.toFixed(1)}`,
        { width: 0.9, height: 0.24, depth: 0.4 },
        scene,
      );
      lampHead.position.set(mx, mastHeight - 0.2, mz);
      lampHead.lookAt(Vector3.Zero());
      lampHead.material = lampMaterial;
      keepStaticMesh(lampHead, true);

      const light = keepLight(
        new PointLight(
          `${map.id}-mast-light-${mx.toFixed(1)}-${mz.toFixed(1)}`,
          new Vector3(mx, mastHeight - 0.3, mz),
          scene,
        ),
        true,
      );
      light.intensity = 0.25;
      light.range = Math.max(22, map.halfSize * 0.7);
      light.diffuse = Color3.FromHexString(palette.lamp);
    }

    beaconBaseY = Math.max(7, map.wallHeight - 1);
    beaconRoot = keepNode(new TransformNode(`${map.id}-beacon`, scene), true);
    beaconRoot.position.set(0, beaconBaseY, 0);

    const core = MeshBuilder.CreateIcoSphere(
      `${map.id}-beacon-core`,
      { radius: 0.45, subdivisions: 2 },
      scene,
    );
    core.parent = beaconRoot;
    core.material = beaconMaterial;
    keepDynamicMesh(core, true);

    ringA = MeshBuilder.CreateTorus(
      `${map.id}-beacon-ring-a`,
      { diameter: 1.7, thickness: 0.06, tessellation: 28 },
      scene,
    );
    ringA.parent = beaconRoot;
    ringA.material = beaconMaterial;
    keepDynamicMesh(ringA, true);

    ringB = MeshBuilder.CreateTorus(
      `${map.id}-beacon-ring-b`,
      { diameter: 2.1, thickness: 0.05, tessellation: 28 },
      scene,
    );
    ringB.parent = beaconRoot;
    ringB.rotation.x = Math.PI / 2;
    ringB.material = beaconMaterial;
    keepDynamicMesh(ringB, true);
  }

  return {
    shadowCasters,

    applyTier(tier: QualityTier): void {
      showOptional = tier.name !== 'low';
      for (const target of optionalTargets) target.setEnabled(showOptional);
    },

    update(now: number): void {
      if (!showOptional || !beaconRoot || !ringA || !ringB) return;
      const seconds = now / 1000;
      ringA.rotation.y = seconds * 0.5;
      ringB.rotation.z = -seconds * 0.35;
      beaconRoot.position.y = beaconBaseY + Math.sin(seconds * 0.8) * 0.14;
    },

    dispose(): void {
      for (const light of lights) light.dispose();
      for (const mesh of meshes) mesh.dispose();
      for (const node of nodes) node.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

export function buildArena(
  engine: AbstractEngine,
  tier: QualityTier,
  initialMap: ArenaMap = getArenaMap(DEFAULT_MAP_ID),
): ArenaScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.09, 0.105, 0.14, 1);
  scene.ambientColor = new Color3(0.34, 0.36, 0.42);
  scene.skipPointerMovePicking = true;
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = new Color3(0.07, 0.102, 0.149);

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.75;
  sky.diffuse = Color3.FromHexString('#b9cbe8');
  sky.groundColor = Color3.FromHexString('#4a5364');

  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.35), scene);
  sun.intensity = 1.5;
  sun.diffuse = Color3.FromHexString('#fff4e2');

  const fill = new DirectionalLight('fill', new Vector3(0.55, -0.35, -0.5), scene);
  fill.intensity = 0.55;
  fill.diffuse = Color3.FromHexString('#8fb0e0');

  const rim = new DirectionalLight('rim', new Vector3(0.1, 0.4, 0.9), scene);
  rim.intensity = 0.3;
  rim.diffuse = Color3.FromHexString('#a8bcd8');

  const camera = new FreeCamera('view', new Vector3(0, EYE_HEIGHT, 0), scene);
  scene.activeCamera = camera;
  camera.minZ = 0.08;
  camera.fov = 1.25;

  let currentTier = tier;
  let currentMap = initialMap;
  let mapRuntime = createMapRuntime(scene, currentMap);
  let shadows: ShadowGenerator | null = null;
  const externalCasters: Mesh[] = [];

  const rebuildShadows = (): void => {
    shadows?.dispose();
    shadows = null;

    if (currentTier.shadowMapSize <= 0) return;

    shadows = new ShadowGenerator(currentTier.shadowMapSize, sun);
    shadows.darkness = 0.3;
    shadows.bias = 0.002;
    shadows.useBlurExponentialShadowMap = currentTier.shadowBlur;
    shadows.useExponentialShadowMap = !currentTier.shadowBlur;
    shadows.blurKernel = currentTier.shadowBlur ? 24 : 1;

    for (const mesh of mapRuntime.shadowCasters) shadows.addShadowCaster(mesh);
    for (const mesh of externalCasters) shadows.addShadowCaster(mesh);
  };

  const syncMapState = (resetCamera: boolean): void => {
    positionSun(sun, currentMap);
    scene.fogDensity = fogDensityFor(currentTier, currentMap);
    camera.maxZ = farPlaneFor(currentTier, currentMap);
    mapRuntime.applyTier(currentTier);
    rebuildShadows();
    if (resetCamera) applySpawnCamera(camera, currentMap);
  };

  syncMapState(true);

  return {
    scene,
    camera,

    applyTier(next: QualityTier): void {
      currentTier = next;
      syncMapState(false);
    },

    setMap(nextMap: ArenaMap): void {
      mapRuntime.dispose();
      currentMap = nextMap;
      mapRuntime = createMapRuntime(scene, currentMap);
      syncMapState(true);
    },

    addShadowCasters(meshes: Mesh[]): void {
      for (const mesh of meshes) {
        if (externalCasters.includes(mesh)) continue;
        externalCasters.push(mesh);
        shadows?.addShadowCaster(mesh);
      }
    },

    update(now: number): void {
      mapRuntime.update(now);
    },

    dispose(): void {
      shadows?.dispose();
      mapRuntime.dispose();
      scene.dispose();
    },
  };
}
