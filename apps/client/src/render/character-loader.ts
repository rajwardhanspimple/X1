/**
 * glTF character loading.
 *
 * A rigged model beats procedural geometry for a humanoid, so this loads one when it is present.
 *
 * Three decisions:
 *
 * The file is parsed ONCE and instanced per enemy. Parsing per figure would stall for seconds when a
 * wave spawns seven at a time, because glTF parsing is synchronous work on the main thread.
 *
 * A missing or broken file falls back to the procedural rig rather than failing. The game must start
 * on a fresh clone with no assets downloaded, and a hard dependency on a binary that is not in the
 * repository would break that.
 *
 * Clip names are matched by case-insensitive substring. Every artist names animations differently:
 * `Idle`, `idle`, `Armature|Idle` and `CharacterArmature|Idle` all occur in real files, and an exact
 * match silently produces a figure frozen in its bind pose.
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

/** Where character models live, relative to the client's public directory. */
export const CHARACTER_MODEL_PATH = '/models/';
export const ENEMY_MODEL_FILE = 'soldier.glb';

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

/**
 * Load a character model.
 *
 * Returns null rather than throwing when the file is missing, because a missing model is an expected
 * state (the repository holds no binaries) and the caller has a working fallback.
 */
export async function loadCharacter(
  scene: Scene,
  file = ENEMY_MODEL_FILE,
): Promise<LoadedCharacter | null> {
  try {
    const result = await SceneLoader.ImportMeshAsync('', CHARACTER_MODEL_PATH, file, scene);

    const template = new TransformNode(`character-template-${file}`, scene);
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
    for (const mesh of result.meshes) {
      const info = mesh.getBoundingInfo?.();
      if (!info) continue;
      minY = Math.min(minY, info.boundingBox.minimumWorld.y);
      maxY = Math.max(maxY, info.boundingBox.maximumWorld.y);
    }
    const height = Number.isFinite(maxY - minY) && maxY > minY ? maxY - minY : 1.8;

    // The template is never drawn; instances are.
    template.setEnabled(false);

    console.info(
      `[rearena] loaded ${file}: ${result.meshes.length} meshes, ${clips.size} clips, ${height.toFixed(2)} units tall`,
    );
    if (clips.size > 0) {
      console.info(`[rearena] clips: ${[...clips.keys()].join(', ')}`);
    }

    return {
      template,
      meshes: result.meshes,
      skeleton: result.skeletons[0] ?? null,
      clips,
      height,
    };
  } catch (error) {
    /*
     * Expected when no model has been added. Logged at info rather than error so it does not read as
     * a failure: the procedural rig is a legitimate path, not a degraded one.
     */
    console.info(
      `[rearena] no character model at ${CHARACTER_MODEL_PATH}${file}, using procedural figures`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
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

  const entries = loaded.template.instantiateHierarchy(root, { doNotInstantiate: false });
  void entries;

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
  const clips = new Map<CharacterClip, AnimationGroup>();
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
 * Play a clip, blending out whatever was playing.
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
