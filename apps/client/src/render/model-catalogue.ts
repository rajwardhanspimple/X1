/**
 * Character model catalogue.
 *
 * Separated from the loader because the list is data, changes for different reasons, and is read by the
 * loader, the developer console and the probe.
 *
 * ## The default is the procedural rig, not a downloaded model
 *
 * Counterintuitive, so the reasoning is worth recording. The built-in rig wins on the thing that matters
 * most for a shooter: **it holds a rifle.** The rig parents weapon geometry to the right hand, so an enemy
 * visibly carries, raises and aims a gun.
 *
 * Every glTF entry below ships body geometry only. Their `Idle_Gun` and `Gun_Shoot` clips pose the hands as
 * though gripping a weapon, but there is no weapon in the file, so the figure mimes. A model with 24 clips
 * and no gun reads worse in a firefight than a simpler figure actually holding one.
 *
 * The rig also needs no attribution, no third-party CDN, and no CORS negotiation; it works offline, scales
 * tessellation with the quality tier, and tints per archetype so a heavy is visibly bulkier than a rusher.
 * The models stay as options because they are better at silhouette and proportion, and because a model with
 * a weapon mesh may turn up later.
 *
 * ## Every entry was measured, not assumed
 *
 * The clip counts below come from reading each file's glTF scene description in the browser, not from its
 * listing page. That distinction earned its keep: seven candidates that looked fine were removed after
 * measurement, including two with no skeleton at all and two with zero animation clips. All were reachable
 * and would have loaded without error, then stood frozen.
 *
 * Two findings no title would have predicted: `cube-guy` has weapon poses and 18 clips at roughly 2k
 * triangles, and `adventurer` carries the same full 24-clip set as SWAT despite being a fantasy character.
 *
 * Re-measure with `rearena.testModels()`; read one file's clip names with `rearena.clips('swat')`.
 *
 * ## Why no Sketchfab models
 *
 * Sketchfab requires a login to download, so a browser cannot fetch one at runtime. A model there tagged
 * "gameready" is unusable here for that reason alone. The `local` option exists for anything converted by
 * hand and dropped into public/models.
 *
 * ## On triangle counts
 *
 * A model's geometry cannot be increased after the fact: subdividing adds vertices without adding features.
 * More detail means a different asset. Detail also costs multiplicatively, because up to eight figures are
 * alive at once plus corpses: a 30k model is 240k triangles on screen where a 7.7k one is 62k.
 */

/**
 * Where a figure's geometry comes from.
 *
 * Explicit rather than inferred from a null URL. Two url-less options now exist (the procedural rig and the
 * local file) and telling them apart by absence would silently load the wrong one.
 */
export type ModelSource = 'procedural' | 'remote' | 'local';

/** What a model can actually do, as measured by the probe. */
export interface ModelCapabilities {
  /** Animation clips in the file. */
  clips: number;
  /** Has weapon-ready, aim or shoot poses. */
  weapon: boolean;
  /** Has directional clips: backpedal and strafe left/right. */
  directional: boolean;
  /** Has hit reactions and a death clip. */
  reactions: boolean;
  /** Carries actual weapon geometry, so the aim poses hold something. */
  weaponMesh: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  kind: ModelSource;
  /** Set only when kind is 'remote'. */
  url: string | null;
  author: string;
  licence: string;
  source: string;
  note: string;
  /** Rough triangle count. Measured precisely on load and logged. */
  triangles: string;
  /** Measured in the browser. Null for the local file, which is whatever the user supplies. */
  capabilities: ModelCapabilities | null;
}

/**
 * Poly Pizza serves glTF from a single CDN host with permissive CORS, because the site is built for
 * `model-viewer` embeds. The preview image and the model share a UUID, which is how these URLs are formed.
 */
const PP = 'https://static.poly.pizza/';
/** three.js examples, served with permissive CORS for the same reason. */
const TJS = 'https://threejs.org/examples/models/gltf/';

/**
 * Capability shorthands. `weaponMesh` is false for every downloaded model: none contain a gun, which is the
 * single reason the procedural rig remains the default.
 */
const FULL: ModelCapabilities = {
  clips: 24,
  weapon: true,
  directional: true,
  reactions: true,
  weaponMesh: false,
};
const ARMED = (clips: number): ModelCapabilities => ({
  clips,
  weapon: true,
  directional: false,
  reactions: true,
  weaponMesh: false,
});
const UNARMED = (clips: number): ModelCapabilities => ({
  clips,
  weapon: false,
  directional: false,
  reactions: true,
  weaponMesh: false,
});
const BASIC = (clips: number): ModelCapabilities => ({
  clips,
  weapon: false,
  directional: false,
  reactions: false,
  weaponMesh: false,
});

export const MODEL_OPTIONS: readonly ModelOption[] = [
  // --- The built-in rig. Default, and the only figure that carries a weapon. -----------------------
  {
    id: 'procedural',
    label: 'Built-in rig',
    kind: 'procedural',
    url: null,
    author: 'this project',
    licence: 'none needed',
    source: 'apps/client/src/render/humanoid.ts',
    note: 'Holds a rifle. Tapered limbs, joint spheres, tier-aware detail, archetype colours.',
    triangles: '1-3k by tier',
    capabilities: {
      // Animated by hand rather than by clip, so the count is nominal: stride, aim, flinch, collapse.
      clips: 4,
      weapon: true,
      directional: false,
      reactions: true,
      weaponMesh: true,
    },
  },

  // --- Complete clip sets: weapon poses, strafes, reactions. No weapon geometry. -------------------
  {
    id: 'swat',
    label: 'SWAT',
    kind: 'remote',
    url: `${PP}713f6535-f4f3-4367-a4c6-ced126ae0936.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/Btfn3G5Xv4',
    note: 'Best silhouette. Complete clip set, but empty hands.',
    triangles: '7.8k',
    capabilities: FULL,
  },
  {
    id: 'soldier-plain',
    label: 'Soldier (Quaternius)',
    kind: 'remote',
    url: `${PP}66a55d04-4286-44a3-b289-0d774c27db5b.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/oAArCNHjFB',
    note: 'Same complete 24-clip set as SWAT, plainer uniform.',
    triangles: '~7k',
    capabilities: FULL,
  },
  {
    id: 'adventurer',
    label: 'Adventurer',
    kind: 'remote',
    url: `${PP}bbe369ee-a686-42c7-adad-14356f5f2f15.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/5EGWBMpuXq',
    note: 'Fantasy look, full 24-clip set including strafes.',
    triangles: '~8k',
    capabilities: FULL,
  },

  // --- Weapon poses and reactions, no directional clips. ------------------------------------------
  {
    id: 'character-animated',
    label: 'Character Animated',
    kind: 'remote',
    url: `${PP}1a8a9d55-9aa9-43c4-a031-d926e251d80a.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/DgOCW9ZCRJ',
    note: 'Generic humanoid, 24 clips with weapon poses.',
    triangles: '~7k',
    capabilities: ARMED(24),
  },
  {
    id: 'matt',
    label: 'Characters Matt',
    kind: 'remote',
    url: `${PP}1e87091b-7202-4906-bd14-22881d9b945c.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/66kQ4dBBC7',
    note: 'Stylised human with weapon poses.',
    triangles: '~5k',
    capabilities: ARMED(20),
  },
  {
    id: 'sam',
    label: 'Characters Sam',
    kind: 'remote',
    url: `${PP}2d0ad9ee-2e86-4b0c-b20e-cfc8c80c8c78.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/UcLErL2W37',
    note: 'Alternate build to Matt, same clip set.',
    triangles: '~5k',
    capabilities: ARMED(20),
  },
  {
    id: 'soldier-quaternius',
    label: 'Character Soldier',
    kind: 'remote',
    url: `${PP}1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/PpLF4rt4ah',
    note: 'Military figure, 14 clips with weapon poses.',
    triangles: '~8k',
    capabilities: ARMED(14),
  },
  {
    id: 'cube-guy',
    label: 'Cube Guy',
    kind: 'remote',
    url: `${PP}7e2096d0-0a62-4d8e-bd51-eb4eaea4e660.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/K1IczhnvQ5',
    note: '18 clips with weapon poses at ~2k triangles. Cheapest animated option.',
    triangles: '~2k',
    capabilities: ARMED(18),
  },

  // --- Locomotion and reactions, no weapon poses. ------------------------------------------------
  {
    id: 'robot-expressive',
    label: 'Robot Expressive',
    kind: 'remote',
    url: `${TJS}RobotExpressive/RobotExpressive.glb`,
    author: 'Tomás Laulhé, modified by Don McCurdy',
    licence: 'CC0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'The only CC0 model, so no credit line needed. 14 clips.',
    triangles: '~8k',
    capabilities: UNARMED(14),
  },
  {
    id: 'man',
    label: 'Man',
    kind: 'remote',
    url: `${PP}3746be88-6799-4817-929b-6bc067c47caa.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/HMnuH5geEG',
    note: 'Civilian build, 11 clips.',
    triangles: '~6k',
    capabilities: UNARMED(11),
  },
  {
    id: 'animated-woman',
    label: 'Animated Woman',
    kind: 'remote',
    url: `${PP}cf08b740-dd48-443e-9fde-6d3d54abf119.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/9kF7eTDbhO',
    note: 'Female build, 10 clips.',
    triangles: '~6k',
    capabilities: UNARMED(10),
  },
  {
    id: 'animated-human',
    label: 'Animated Human',
    kind: 'remote',
    url: `${PP}170235d2-cdeb-4cb2-a82f-4828585138fe.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/c3Ibh9I3udk',
    note: 'Plain human, 8 clips.',
    triangles: '~6k',
    capabilities: UNARMED(8),
  },

  // --- Locomotion only. A figure will never visibly aim, flinch or die. --------------------------
  {
    id: 'soldier-hd',
    label: 'Soldier (high detail)',
    kind: 'remote',
    url: `${TJS}Soldier.glb`,
    author: 'three.js examples',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Most detailed human, but only 4 clips: no aim, shoot, flinch or death.',
    triangles: '~30k',
    capabilities: BASIC(4),
  },
  {
    id: 'xbot',
    label: 'X Bot',
    kind: 'remote',
    url: `${TJS}Xbot.glb`,
    author: 'Mixamo via three.js',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Mixamo rig, so Mixamo rifle clips retarget onto it. 7 clips as shipped.',
    triangles: '~10k',
    capabilities: BASIC(7),
  },
  {
    id: 'zombie',
    label: 'Animated Zombie',
    kind: 'remote',
    url: `${PP}972d277d-6fc4-46c7-85d1-e4d68cf46548.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/jkrEvQZb8J',
    note: 'Shambling gait. Suits a rusher that closes without shooting.',
    triangles: '~7k',
    capabilities: BASIC(5),
  },

  // --- Local override ----------------------------------------------------------------------------
  {
    id: 'local',
    label: 'Local file',
    kind: 'local',
    url: null,
    author: 'whatever you put there',
    licence: 'yours to check',
    source: 'apps/client/public/models/soldier.glb',
    note: 'Loads only when selected. Any rigged .glb at that path.',
    triangles: 'varies',
    capabilities: null,
  },
];

/**
 * Default: the built-in rig.
 *
 * It is the only figure that holds a weapon, needs no attribution, and works with no network. The downloaded
 * models look better standing still and worse in a firefight, because a soldier miming an empty-handed aim
 * pose is a more visible error than slightly blocky geometry.
 */
export const DEFAULT_MODEL_ID = 'procedural';

export function modelById(id: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === id);
}

/** Short capability summary for the console listing. */
export function capabilitySummary(option: ModelOption): string {
  const caps = option.capabilities;
  if (!caps) return 'unknown';
  const tags = [
    caps.weaponMesh ? 'HOLDS GUN' : caps.weapon ? 'gun poses' : null,
    caps.directional ? 'strafe' : null,
    caps.reactions ? 'hit/death' : null,
  ].filter((t): t is string => t !== null);
  return `${caps.clips} clips${tags.length > 0 ? ` ${tags.join(' ')}` : ''}`;
}
