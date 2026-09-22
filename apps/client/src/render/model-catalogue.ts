/**
 * Character model catalogue.
 *
 * Separated from the loader because the list is data, changes for different reasons, and is read by both
 * the loader and the developer console.
 *
 * ## Every entry here was verified animated
 *
 * Not inferred from a title. A model without a skeleton loads without error and then stands frozen, which
 * looks exactly like an animation bug and wastes an hour to diagnose. The Poly Pizza entries come from
 * that site's animated-only filter; the three.js entries are files in that repository's examples.
 *
 * ## Why no Sketchfab models
 *
 * Sketchfab requires a login to download, so a browser cannot fetch one at runtime. A model there tagged
 * "gameready" is still unusable here for that reason alone, regardless of quality. The `local` option
 * exists for anything converted by hand and dropped into public/models.
 *
 * ## On triangle counts
 *
 * A model's geometry cannot be increased after the fact: subdividing adds vertices without adding
 * features, so a smoothed low-poly character still reads as low-poly. More detail means a different asset.
 *
 * Detail also costs multiplicatively rather than additively, because up to eight figures are alive at once
 * plus corpses. A 30k-triangle model is 240k on screen where a 7.7k one is 62k, and the difference lands
 * on the weakest device that has to run it.
 */

export interface ModelOption {
  id: string;
  label: string;
  /** Remote URL, or null for the local file at public/models/soldier.glb. */
  url: string | null;
  author: string;
  licence: string;
  source: string;
  note: string;
  /** Rough triangle count. Measured precisely on load and logged. */
  triangles: string;
}

/**
 * Poly Pizza serves glTF from a single CDN host with permissive CORS, because the site is built for
 * `model-viewer` embeds. The preview image and the model share a UUID, which is how these URLs are formed.
 */
const PP = 'https://static.poly.pizza/';
/** three.js examples, served with permissive CORS for the same reason. */
const TJS = 'https://threejs.org/examples/models/gltf/';

export const MODEL_OPTIONS: readonly ModelOption[] = [
  // --- Military and tactical: the right genre for an arena shooter ---------------------------------
  {
    id: 'swat',
    label: 'SWAT',
    url: `${PP}713f6535-f4f3-4367-a4c6-ced126ae0936.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/Btfn3G5Xv4',
    note: 'Tactical operator. 24 clips: aim, point, shoot, run-and-shoot, two flinches.',
    triangles: '7.8k',
  },
  {
    id: 'soldier-quaternius',
    label: 'Character Soldier',
    url: `${PP}1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/PpLF4rt4ah',
    note: 'Military figure, same 24-clip rig as SWAT.',
    triangles: '~8k',
  },
  {
    id: 'soldier-hd',
    label: 'Soldier (high detail)',
    url: `${TJS}Soldier.glb`,
    author: 'three.js examples',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Most detailed human. Idle, walk, run only, so combat poses fall back.',
    triangles: '~30k',
  },
  {
    id: 'soldier-plain',
    label: 'Soldier (Quaternius)',
    url: `${PP}66a55d04-4286-44a3-b289-0d774c27db5b.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/oAArCNHjFB',
    note: 'Plainer uniform, lighter silhouette.',
    triangles: '~7k',
  },
  {
    id: 'soldier-kolos',
    label: 'Soldier (KolosStudios)',
    url: `${PP}42b9173f-a91c-4abf-b6f5-b21a3965f61a.glb`,
    author: 'KolosStudios',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/XT8jgwSesV',
    note: 'Different artist, so a different look from the Quaternius set.',
    triangles: '~6k',
  },
  {
    id: 'knight',
    label: 'Knight',
    url: `${PP}5aef0a90-a166-4024-b3bb-ca6ad8c733f3.glb`,
    author: 'Dawid2K',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/isC73B8SKq',
    note: 'Armoured. Reads as heavy, which suits the heavy archetype.',
    triangles: '~9k',
  },

  // --- Human characters ---------------------------------------------------------------------------
  {
    id: 'character-animated',
    label: 'Character Animated',
    url: `${PP}1a8a9d55-9aa9-43c4-a031-d926e251d80a.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/DgOCW9ZCRJ',
    note: 'Generic humanoid with the full clip set. Good baseline.',
    triangles: '~7k',
  },
  {
    id: 'animated-human',
    label: 'Animated Human',
    url: `${PP}170235d2-cdeb-4cb2-a82f-4828585138fe.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/c3Ibh9I3udk',
    note: 'Plain human, minimal styling.',
    triangles: '~6k',
  },
  {
    id: 'man',
    label: 'Man',
    url: `${PP}3746be88-6799-4817-929b-6bc067c47caa.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/HMnuH5geEG',
    note: 'Civilian build.',
    triangles: '~6k',
  },
  {
    id: 'animated-woman',
    label: 'Animated Woman',
    url: `${PP}cf08b740-dd48-443e-9fde-6d3d54abf119.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/9kF7eTDbhO',
    note: 'Female build, same rig. Useful for enemy variety.',
    triangles: '~6k',
  },
  {
    id: 'michelle',
    label: 'Michelle',
    url: `${TJS}Michelle.glb`,
    author: 'Mixamo via three.js',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Mixamo rig, so Mixamo clips retarget onto it. Realistic proportions.',
    triangles: '~15k',
  },
  {
    id: 'readyplayerme',
    label: 'Ready Player Me avatar',
    url: `${TJS}readyplayer.me.glb`,
    author: 'Ready Player Me via three.js',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Avatar-style human, half-body detail.',
    triangles: '~12k',
  },
  {
    id: 'character-base',
    label: 'Character Base',
    url: `${PP}6475fb6e-e560-4b27-afc2-042896b70137.glb`,
    author: 'madtrollstudio',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/qbDLeTtb8K',
    note: 'Untextured base mesh. Clean silhouette, no uniform.',
    triangles: '~5k',
  },
  {
    id: 'rigged-character',
    label: 'Rigged Character',
    url: `${PP}e992e5f8-3bea-4cca-80e7-8dac71689884.glb`,
    author: 'Rafael',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/yiQDOLP4Ry',
    note: 'Simple rig, reliable animation.',
    triangles: '~4k',
  },
  {
    id: 'adventurer',
    label: 'Adventurer',
    url: `${PP}bbe369ee-a686-42c7-adad-14356f5f2f15.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/5EGWBMpuXq',
    note: 'Fantasy, but well made and fully animated.',
    triangles: '~8k',
  },
  {
    id: 'fitness',
    label: 'Fitness Character',
    url: `${PP}ca6d7f88-fb9e-4c6c-8d6e-acfce081a21d.glb`,
    author: 'iPoly3D',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/eMOTyGEAxj',
    note: 'Athletic build. Reads as fast, which suits the rusher archetype.',
    triangles: '~7k',
  },
  {
    id: 'matt',
    label: 'Characters Matt',
    url: `${PP}1e87091b-7202-4906-bd14-22881d9b945c.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/66kQ4dBBC7',
    note: 'Stylised human.',
    triangles: '~5k',
  },
  {
    id: 'sam',
    label: 'Characters Sam',
    url: `${PP}2d0ad9ee-2e86-4b0c-b20e-cfc8c80c8c78.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/UcLErL2W37',
    note: 'Stylised human, alternate build.',
    triangles: '~5k',
  },

  // --- Non-human: sidesteps the uncanny valley entirely -------------------------------------------
  {
    id: 'zombie',
    label: 'Animated Zombie',
    url: `${PP}972d277d-6fc4-46c7-85d1-e4d68cf46548.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/jkrEvQZb8J',
    note: 'Shambling gait suits a rusher that closes without shooting.',
    triangles: '~7k',
  },
  {
    id: 'xbot',
    label: 'X Bot',
    url: `${TJS}Xbot.glb`,
    author: 'Mixamo via three.js',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Mixamo rig on a robot. Accepts Mixamo rifle clips.',
    triangles: '~10k',
  },
  {
    id: 'robot-expressive',
    label: 'Robot Expressive',
    url: `${TJS}RobotExpressive/RobotExpressive.glb`,
    author: 'Tomás Laulhé, modified by Don McCurdy',
    licence: 'CC0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'The only CC0 entry, so no credit needed. 14 clips including Death and ThumbsUp.',
    triangles: '~8k',
  },
  {
    id: 'cube-guy',
    label: 'Cube Guy',
    url: `${PP}7e2096d0-0a62-4d8e-bd51-eb4eaea4e660.glb`,
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/K1IczhnvQ5',
    note: 'Blocky and deliberately abstract. Cheapest option.',
    triangles: '~2k',
  },

  // --- Local override ----------------------------------------------------------------------------
  {
    id: 'local',
    label: 'Local file',
    url: null,
    author: 'whatever you put there',
    licence: 'yours to check',
    source: 'apps/client/public/models/soldier.glb',
    note: 'Loads only when selected. Any rigged .glb at that path, including a Sketchfab conversion.',
    triangles: 'varies',
  },
];

/**
 * Default.
 *
 * SWAT rather than the highest-detail option, because it has 24 clips against the high-detail soldier's
 * three. Aim, shoot, strafe and flinch poses do more for how a figure reads in a firefight than four times
 * the triangles: a detailed model playing a forward run while strafing looks worse than a simple one
 * playing the right clip.
 */
export const DEFAULT_MODEL_ID = 'swat';

export function modelById(id: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === id);
}
