/**
 * glTF character loading.
 *
 * The catalogue of available figures lives in model-catalogue.ts; this file parses, instances and animates
 * whichever one is selected.
 *
 * Resolution branches on the selected option's `kind`:
 *
 *  - `procedural` returns null immediately, and the enemy renderer builds figures from primitives. This is
 *    the default, because the built-in rig is the only figure that actually holds a rifle.
 *  - `local` reads public/models/soldier.glb, and only when explicitly selected. An earlier version preferred
 *    it unconditionally, which meant a file dropped in at some point silently outranked every other option.
 *  - `remote` fetches a glTF, falling back through the other remote candidates if it fails, then to
 *    procedural figures.
 *
 * The remote path has a known limitation, recorded here rather than discovered later: depending on a
 * third-party CDN at runtime makes someone else's uptime our uptime. Before launch a chosen model is copied
 * into our own Cloudflare Workers Static Assets bucket alongside the content bundles (WO-7).
 *
 * The file is parsed ONCE and instanced per enemy. Parsing per figure would stall for seconds when a wave
 * spawns seven at a time, because glTF parsing is synchronous work on the main thread.
 */

import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton.js';
import type { Scene } from '@babylonjs/core/scene.js';
import '@babylonjs/loaders/glTF/2.0/index.js';
import { DEFAULT_MODEL_ID, MODEL_OPTIONS, modelById, type ModelOption } from './model-catalogue.js';
import { inspectModel, logInspection, type ModelInspection } from './model-inspect.js';

export { MODEL_OPTIONS, DEFAULT_MODEL_ID, modelById, type ModelOption };

const SELECTION_KEY = 'rearena.model.v1';

/** Local file path, used when the `local` option is selected. */
const LOCAL_MODEL_PATH = '/models/';
const LOCAL_MODEL_FILE = 'soldier.glb';

export function selectedModelId(): string {
  try {
    const stored = localStorage.getItem(SELECTION_KEY);
    if (stored && modelById(stored)) return stored;
  } catch {
    // Private browsing. Fall through to the default.
  }
  return DEFAULT_MODEL_ID;
}

export function setSelectedModelId(id: string): boolean {
  if (!modelById(id)) return false;
  try {
    localStorage.setItem(SELECTION_KEY, id);
  } catch {
    // Storage unavailable; the choice applies for this session only.
  }
  return true;
}

/**
 * Logical animation states the renderer asks for.
 *
 * More than a minimal set, because a good model has more than a minimal set. Directional runs matter most:
 * an enemy strafing sideways while playing a forward run slides visibly, and that single mismatch does more
 * to make figures look wrong than any amount of geometry detail.
 */
export type CharacterClip =
  | 'idle'
  /** Weapon lowered, at rest. */
  | 'idleNeutral'
  /** Weapon up, ready. */
  | 'aim'
  /** Weapon up and pointed at a target: the telegraph pose. */
  | 'aimPointing'
  | 'walk'
  | 'run'
  | 'runBack'
  | 'runLeft'
  | 'runRight'
  | 'shoot'
  /** Firing while moving. */
  | 'shootMoving'
  | 'death'
  | 'hit'
  /** Second flinch variant, so repeated hits are not identical. */
  | 'hitAlt'
  | 'roll';

/**
 * Candidate names per logical clip, most to least specific.
 *
 * Each is tried as an EXACT match on the clip's final name segment before any substring matching. That
 * ordering matters: with substring alone, `run` resolves to whichever of `Run`, `Run_Back`, `Run_Left`
 * appears first in the file, which is correct by luck for one model and wrong for the next.
 */
const CLIP_CANDIDATES: Record<CharacterClip, string[]> = {
  idle: ['idle', 'idle_neutral', 'idle_gun'],
  idleNeutral: ['idle_neutral', 'idle'],
  // A weapon-ready idle is the right default for an armed enemy, so plain idle is the fallback.
  aim: ['idle_gun', 'aim', 'idle_shoot', 'idle'],
  aimPointing: ['idle_gun_pointing', 'aim_pointing', 'idle_gun'],
  walk: ['walk', 'walking'],
  run: ['run', 'sprint', 'jog', 'walk'],
  runBack: ['run_back', 'walk_back', 'run_backward'],
  runLeft: ['run_left', 'walk_left', 'strafe_left'],
  runRight: ['run_right', 'walk_right', 'strafe_right'],
  shoot: ['gun_shoot', 'idle_gun_shoot', 'shoot', 'fire', 'attack'],
  shootMoving: ['run_shoot', 'walk_shoot', 'gun_shoot'],
  death: ['death', 'die', 'dead'],
  // Note the misspelling: "HitRecieve" appears in real files and is worth matching directly.
  hit: ['hitrecieve', 'hitreceive', 'hit', 'damage', 'impact', 'flinch'],
  hitAlt: ['hitrecieve_2', 'hitreceive_2', 'hit_2'],
  roll: ['roll', 'dodge', 'dive'],
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
  /** Measured triangle count, for the performance note in the console. */
  triangles: number;
  /** What the file contains: weapon geometry, bones, hand attachment points. */
  inspection: ModelInspection;
  /** Which option produced this, for the credits screen and for debugging. */
  option: ModelOption;
}

/**
 * One instantiated figure: its own transform tree and its own animation state, so two enemies are not
 * lock-stepped to the same frame.
 */
export interface CharacterInstance {
  root: TransformNode;
  meshes: AbstractMesh[];
  clips: Map<CharacterClip, AnimationGroup>;
  current: CharacterClip | null;
  dispose(): void;
}

/**
 * The part of a clip name that identifies the animation.
 *
 * Exporters prefix the armature: `CharacterArmature|Idle`, `Armature|Walk`, `mixamorig|Run`. The segment
 * after the last separator is the actual name.
 */
function clipKey(name: string): string {
  const parts = name.split(/[|:]/);
  return (parts[parts.length - 1] ?? name).trim().toLowerCase();
}

/**
 * Resolve a logical clip against whatever the file contains.
 *
 * Exact match on the key first, across all candidates, then substring as a last resort. Doing exact passes
 * for every candidate before any substring pass is what stops a specific clip losing to a vaguely similar
 * one that happens to appear earlier in the file.
 */
function matchClip(clips: Map<string, AnimationGroup>, want: CharacterClip): AnimationGroup | null {
  const candidates = CLIP_CANDIDATES[want];

  for (const candidate of candidates) {
    for (const [name, group] of clips) {
      if (clipKey(name) === candidate) return group;
    }
  }

  for (const candidate of candidates) {
    for (const [name, group] of clips) {
      if (clipKey(name).includes(candidate)) return group;
    }
  }

  return null;
}

/** Parse one glTF. Throws on any failure. */
async function parseModel(
  scene: Scene,
  rootUrl: string,
  fileName: string,
  option: ModelOption,
): Promise<LoadedCharacter> {
  const result = await SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene);

  if (result.meshes.length === 0) throw new Error('model contained no meshes');

  const template = new TransformNode(`character-template-${option.id}`, scene);
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
  const rounded = Math.round(triangles);
  const skeleton = result.skeletons[0] ?? null;

  template.setEnabled(false);

  console.info(
    `[rearena] model "${option.label}" by ${option.author} (${option.licence}): ` +
      `${result.meshes.length} meshes, ${rounded} triangles, ${clips.size} clips, ` +
      `${height.toFixed(2)} units tall`,
  );

  /*
   * Cost is multiplicative: up to eight figures are alive at once plus corpses, so per-figure geometry lands
   * on screen nine or ten times over. Saying so at load is more useful than discovering it as a frame drop
   * during a late wave.
   */
  if (rounded > 20000) {
    console.warn(
      `[rearena] ${rounded} triangles per figure means roughly ${(rounded * 8).toLocaleString()} ` +
        'with a full wave alive. Watch the F overlay on the weakest device you care about.',
    );
  }

  const inspection = inspectModel(result.meshes, skeleton);
  logInspection(inspection);

  if (clips.size === 0) {
    // Worth saying plainly: a rigged model with no clips stands still, which reads as broken.
    console.warn('[rearena] model has no animation clips; figures will not animate');
  } else {
    /*
     * Log the resolved mapping rather than the raw clip list. The raw names say what the file has; the
     * mapping says what the game will actually play, which is the thing that goes wrong.
     */
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const logical of Object.keys(CLIP_CANDIDATES) as CharacterClip[]) {
      const match = matchClip(clips, logical);
      if (match) resolved.push(`${logical}=${clipKey(match.name)}`);
      else missing.push(logical);
    }
    console.info(`[rearena] clip mapping: ${resolved.join(', ')}`);
    if (missing.length > 0) {
      console.info(`[rearena] no clip for: ${missing.join(', ')} (falls back to a general clip)`);
    }
  }

  return {
    template,
    meshes: result.meshes,
    skeleton,
    clips,
    height,
    triangles: rounded,
    inspection,
    option,
  };
}

/** Split a URL into the root and filename Babylon's loader expects. */
function splitUrl(url: string): { root: string; file: string } {
  const cut = url.lastIndexOf('/') + 1;
  return { root: url.slice(0, cut), file: url.slice(cut) };
}

async function loadOption(scene: Scene, option: ModelOption): Promise<LoadedCharacter> {
  if (option.kind === 'local') {
    return parseModel(scene, LOCAL_MODEL_PATH, LOCAL_MODEL_FILE, option);
  }
  if (option.kind === 'procedural' || option.url === null) {
    // Callers check for the procedural kind before reaching here; this is a guard, not a path.
    throw new Error('procedural figures are not loaded from a file');
  }
  const { root, file } = splitUrl(option.url);
  return parseModel(scene, root, file, option);
}

/**
 * Load the selected character, or null to use procedural figures.
 *
 * Never throws: a missing model is an expected state, not an error, and the game must start regardless.
 */
export async function loadCharacter(
  scene: Scene,
  preferredId = selectedModelId(),
): Promise<LoadedCharacter | null> {
  const selected = modelById(preferredId) ?? modelById(DEFAULT_MODEL_ID);

  // The built-in rig is a deliberate choice, so it returns immediately without touching the network.
  if (!selected || selected.kind === 'procedural') {
    console.info('[rearena] using the built-in rig (holds a weapon, no download)');
    return null;
  }

  try {
    return await loadOption(scene, selected);
  } catch (error) {
    console.info(
      `[rearena] could not load "${selected.label}":`,
      error instanceof Error ? error.message : error,
    );
  }

  /*
   * Fall back through the REMOTE candidates only. The local file is excluded deliberately: falling back to
   * it would load a model the user never selected, which is the same class of surprise as the local file
   * outranking an explicit choice.
   */
  for (const option of MODEL_OPTIONS) {
    if (option.kind !== 'remote' || option.id === selected.id) continue;
    try {
      return await loadOption(scene, option);
    } catch (error) {
      console.info(
        `[rearena] could not load "${option.label}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.info('[rearena] no model available, using the built-in rig');
  return null;
}

/**
 * Create one instance from a loaded template.
 *
 * instantiateHierarchy with cloned animation groups gives each figure its own playback state. Sharing groups
 * would make every enemy play the same frame of the same clip, which reads as a chorus line.
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
   * Clone each animation group and retarget it onto this instance's nodes. Babylon's clone takes a mapper
   * from the original target to the new one, which is how one template drives many figures.
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

/** True when the instance actually has a clip for this state. */
export function hasClip(instance: CharacterInstance, clip: CharacterClip): boolean {
  return instance.clips.has(clip);
}

/**
 * Play a clip, stopping whatever was playing.
 *
 * `loop` is false for one-shots (shoot, hit, death) and true for locomotion. A death clip that loops makes a
 * corpse stand back up, which is the most common bug when wiring a new model.
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

/**
 * Play the first clip in the list the model actually has.
 *
 * Lets a caller ask for something specific and degrade gracefully: `runLeft`, else `run`, else `walk`. A
 * model with only `Run` behaves exactly as it did before directional clips existed.
 */
export function playFirstAvailable(
  instance: CharacterInstance,
  clips: readonly CharacterClip[],
  loop = true,
  speed = 1,
): CharacterClip | null {
  for (const clip of clips) {
    if (instance.clips.has(clip)) {
      playClip(instance, clip, loop, speed);
      return clip;
    }
  }
  return null;
}

/** Match locomotion playback rate to actual movement, so feet do not slide. */
export function setClipSpeed(instance: CharacterInstance, speed: number): void {
  if (!instance.current) return;
  const group = instance.clips.get(instance.current);
  if (group) group.speedRatio = speed;
}

/** True when the current clip is a one-shot that should be left to finish. */
export function isPlayingOneShot(instance: CharacterInstance): boolean {
  const current = instance.current;
  if (!current) return false;
  return current === 'shoot' || current === 'hit' || current === 'hitAlt' || current === 'roll';
}
