/**
 * glTF character loading.
 *
 * A rigged model beats procedural geometry for a humanoid, so this loads one when it can.
 *
 * Source order, most to least preferred:
 *
 *  1. A local file at `public/models/soldier.glb`. Dropping one in overrides everything below with no
 *     code change.
 *  2. A remote glTF from the CDN list. This is why the game has rigged characters on a fresh clone
 *     with nothing downloaded: the repository holds no binaries, and requiring a manual download
 *     before the game looks right is a bad first run.
 *  3. Procedural figures, built from primitives. Not a degraded mode; it is what runs offline.
 *
 * The remote path is a development convenience with a known limitation, recorded here rather than
 * discovered later: depending on a third-party CDN at runtime makes someone else's uptime our uptime,
 * and their CORS policy our CORS policy. Before launch the chosen model is copied into our own
 * Cloudflare Workers Static Assets bucket alongside the content bundles (WO-7), and this list becomes
 * a fallback rather than the primary. It is not a problem today because a failure lands on procedural
 * figures and the game keeps working.
 *
 * Two implementation notes:
 *
 * The file is parsed ONCE and instanced per enemy. Parsing per figure would stall for seconds when a
 * wave spawns seven at a time, because glTF parsing is synchronous work on the main thread.
 *
 * Clip names are matched by case-insensitive substring. Every artist names animations differently:
 * `Idle`, `idle`, `Armature|Idle`, `CharacterArmature|Idle` and `Rifle Idle` all occur in real files,
 * and an exact match silently produces a figure frozen in its bind pose.
 */

import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton.js';
import type { Scene } from '@babylonjs/core/scene.js';
import '@babylonjs/loaders/glTF/2.0/index.js';

/** Local override, checked first. */
export const LOCAL_MODEL_PATH = '/models/';
export const LOCAL_MODEL_FILE = 'soldier.glb';

/**
 * Remote candidates, in priority order.
 *
 * All are rigged, animated, low-poly characters from Poly Pizza's CDN, which serves glTF with
 * permissive CORS because it is built for `model-viewer` embeds. Low-poly rather than photoreal is
 * deliberate: a 100k-triangle character with 4K textures is roughly 25x the geometry and 16x the
 * texture memory an arena figure needs, and eight of them alive at once is the difference between
 * playable and not on a phone.
 *
 * Licences are recorded per entry because "where did this come from" is always asked later and is
 * painful to answer retroactively.
 */
export interface RemoteModel {
  label: string;
  url: string;
  author: string;
  licence: string;
  source: string;
}

export const REMOTE_MODELS: readonly RemoteModel[] = [
  {
    label: 'SWAT',
    url: 'https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/Btfn3G5Xv4',
  },
  {
    label: 'Character Soldier',
    url: 'https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/PpLF4rt4ah',
  },
  {
    label: 'Soldier',
    url: 'https://static.poly.pizza/66a55d04-4286-44a3-b289-0d774c27db5b.glb',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/oAArCNHjFB',
  },
  {
    label: 'Soldier (KolosStudios)',
    url: 'https://static.poly.pizza/42b9173f-a91c-4abf-b6f5-b21a3965f61a.glb',
    author: 'KolosStudios',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/XT8jgwSesV',
  },
  {
    label: 'Character Animated',
    url: 'https://static.poly.pizza/1a8a9d55-9aa9-43c4-a031-d926e251d80a.glb',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/DgOCW9ZCRJ',
  },
];

/** Logical animation states the renderer asks for. */
export type CharacterClip = 'idle' | 'walk' | 'run' | 'aim' | 'shoot' | 'death' | 'hit';

/**
 * Candidate clip names per logical state, in priority order.
 *
 * Loose matching by substring, because a model's clips are whatever the artist called them. The
 * first candidate that appears as a substring of a clip name wins.
 */
const CLIP_CANDIDATES: Record<CharacterClip, string[]> = {
  idle: ['idle'],
  walk: ['walk', 'walking'],
  run: ['run', 'sprint', 'jog'],
  aim: ['aim', 'idle_gun', 'idle_shoot', 'gun'],
  shoot: ['shoot', 'fire', 'attack'],
  death: ['death', 'die', 'dead'],
  hit: ['hit', 'damage', 'impact', 'flinch'],
};

export interface LoadedCharacter {
  /** The parsed root, kept hidden and used only as a template for instancing. */
  template: TransformNode;
  meshes: AbstractMesh[];
  skeleton: Skeleton | null;
  /** Animation groups from the file, by their original names. */
  clips: Map<string, AnimationGroup>;
  /** Height of the model in world units, for scaling it to the 1.8 unit hitbox. */
  height: number;
  /** Where it came from, for the credits screen and for debugging. */
  origin: string;
}

/**
 * One instantiated figure: its own transform tree and its own animation state, so two enemies are
 * not lock-stepped to the same frame.
 */
export interface CharacterInstance {
  root: TransformNode;
  meshes: AbstractMesh[];
  clips: Map<CharacterClip, AnimationGroup>;
  current: CharacterClip | null;
  dispose(): void;
}

/** Resolve a logical clip against whatever the file actually contains. */
function matchClip(
  clips: Map<string, AnimationGroup>,
  want: CharacterClip,
): AnimationGroup | null {
  const candidates = CLIP_CANDIDATES[want];
  for (const candidate of candidates) {
    for (const [name, group] of clips) {
      if (name.toLowerCase().includes(candidate)) return group;
    }
  }
  return null;
}

/** Parse one glTF from a root path and filename. Throws on any failure. */
async function parseModel(
  scene: Scene,
  rootUrl: string,
  fileName: string,
  origin: string,
): Promise<LoadedCharacter> {
  const result = await SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene);

  const template = new TransformNode(`character-template-${origin}`, scene);
  // Reparent the loaded roots under one node so the whole model moves as a unit.
  for (const mesh of result.meshes) {
    if (!mesh.parent) mesh.parent = template;
    mesh.isPickable = false;
  }

  const clips = new Map<string, AnimationGroup>();
  for (const group of result.animationGroups) {
    // Stop everything on the template: only instances play.
    group.stop();
    clips.set(group.name, group);
  }

  // Measure the model so it can be scaled to match the simulation's 1.8 unit hitbox.
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let triangles = 0;
  for (const mesh of result.meshes) {
    const info = mesh.getBoundingInfo?.();
    if (info) {
      minY = Math.min(minY, info.boundingBox.minimumWorld.y);
      maxY = Math.max(maxY, info.boundingBox.maximumWorld.y);
    }
    triangles += (mesh.getTotalIndices?.() ?? 0) / 3;
  }
  const height = Number.isFinite(maxY - minY) && maxY > minY ? maxY - minY : 1.8;

  if (result.meshes.length === 0) {
    throw new Error('model contained no meshes');
  }

  // The template is never drawn; instances are.
  template.setEnabled(false);

  console.info(
    `[rearena] loaded ${origin}: ${result.meshes.length} meshes, ${Math.round(triangles)} triangles, ` +
      `${clips.size} clips, ${height.toFixed(2)} units tall`,
  );
  if (clips.size > 0) {
    console.info(`[rearena] clips: ${[...clips.keys()].join(', ')}`);
  } else {
    // Worth saying plainly: a rigged model with no clips will stand still, which looks broken.
    console.warn('[rearena] model has no animation clips; figures will not animate');
  }

  return {
    template,
    meshes: result.meshes,
    skeleton: result.skeletons[0] ?? null,
    clips,
    height,
    origin,
  };
}

/** Split a URL into the root and filename Babylon's loader expects. */
function splitUrl(url: string): { root: string; file: string } {
  const cut = url.lastIndexOf('/') + 1;
  return { root: url.slice(0, cut), file: url.slice(cut) };
}

/**
 * Load a character.
 *
 * Tries the local file, then each remote candidate, and returns null when every source fails so the
 * caller falls back to procedural figures. Never throws: a missing model is an expected state, not
 * an error, and the game must start regardless.
 */
export async function loadCharacter(scene: Scene): Promise<LoadedCharacter | null> {
  // 1. Local file wins, so dropping one in overrides the remote list.
  try {
    return await parseModel(scene, LOCAL_MODEL_PATH, LOCAL_MODEL_FILE, 'local soldier.glb');
  } catch {
    // Expected on a fresh clone. No log: the remote attempt below is the normal path.
  }

  // 2. Remote candidates, first that parses wins.
  for (const model of REMOTE_MODELS) {
    try {
      const { root, file } = splitUrl(model.url);
      const loaded = await parseModel(scene, root, file, `${model.label} by ${model.author}`);
      console.info(`[rearena] ${model.label} (${model.licence}) from ${model.source}`);
      return loaded;
    } catch (error) {
      console.info(
        `[rearena] could not load ${model.label}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // 3. Procedural figures. A legitimate path, so this is info rather than a warning.
  console.info('[rearena] no character model available, using procedural figures');
  return null;
}

/**
 * Create one instance from a loaded template.
 *
 * instantiateHierarchy with cloned animation groups gives each figure its own playback state. Sharing
 * groups would make every enemy play the same frame of the same clip, which reads as a chorus line.
 */
export function instantiateCharacter(
  loaded: LoadedCharacter,
  scene: Scene,
  id: string,
  targetHeight = 1.8,
): CharacterInstance {
  const root = new TransformNode(`character-${id}`, scene);

  loaded.template.instantiateHierarchy(root, { doNotInstantiate: false });

  const meshes: AbstractMesh[] = [];
  for (const child of root.getChildMeshes()) {
    child.isPickable = false;
    child.setEnabled(true);
    meshes.push(child);
  }

  // Scale to the simulation's hitbox height, so a model authored at any size fits the game.
  const scale = loaded.height > 0 ? targetHeight / loaded.height : 1;
  root.scaling = new Vector3(scale, scale, scale);

  /*
   * Clone each animation group and retarget it onto this instance's nodes. Babylon's clone takes a
   * mapper from the original target to the new one, which is how one template drives many figures.
   */
  const named = new Map<string, AnimationGroup>();
  for (const [name, group] of loaded.clips) {
    const clone = group.clone(`${name}-${id}`, (target: unknown) => {
      const node = target as { name?: string } | null;
      if (!node?.name) return target;
      // Match by name within this instance's subtree. Babylon suffixes instantiated nodes.
      const match =
        root.getChildTransformNodes(false, (n) => n.name.includes(node.name!))[0] ??
        root.getChildMeshes(false, (n) => n.name.includes(node.name!))[0];
      return match ?? target;
    });
    if (clone) {
      clone.stop();
      named.set(name, clone);
    }
  }

  const clips = new Map<CharacterClip, AnimationGroup>();
  for (const logical of Object.keys(CLIP_CANDIDATES) as CharacterClip[]) {
    const match = matchClip(named, logical);
    if (match) clips.set(logical, match);
  }

  return {
    root,
    meshes,
    clips,
    current: null,
    dispose() {
      for (const group of named.values()) group.dispose();
      root.dispose(false, true);
    },
  };
}

/**
 * Play a clip, stopping whatever was playing.
 *
 * `loop` is false for one-shots (shoot, hit, death) and true for locomotion. A death clip that loops
 * makes a corpse stand back up, which is the most common bug when wiring a new model.
 */
export function playClip(
  instance: CharacterInstance,
  clip: CharacterClip,
  loop = true,
  speed = 1,
): boolean {
  if (instance.current === clip) return true;
  const group = instance.clips.get(clip);
  if (!group) return false;

  for (const [name, other] of instance.clips) {
    if (name !== clip) other.stop();
  }

  group.speedRatio = speed;
  group.play(loop);
  instance.current = clip;
  return true;
}

/** Match locomotion playback rate to actual movement, so feet do not slide. */
export function setClipSpeed(instance: CharacterInstance, speed: number): void {
  if (!instance.current) return;
  const group = instance.clips.get(instance.current);
  if (group) group.speedRatio = speed;
}
