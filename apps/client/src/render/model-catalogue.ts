/**
 * Character model catalogue.
 *
 * Separated from the loader because the list is data, changes for different reasons, and is read by both
 * the loader and the developer console.
 *
 * A note on triangle counts, since it is the first thing anyone asks to change: a model's geometry cannot
 * be increased after the fact. Subdividing a mesh adds vertices without adding features, so a smoothed
 * low-poly character still reads as a low-poly character. More detail means a different asset.
 *
 * Detail also costs multiplicatively here rather than additively, because up to eight figures are alive
 * at once plus corpses. A 30k-triangle model is 240k triangles on screen where a 7.7k one is 62k, and
 * the difference lands on the weakest device that has to run it. Each entry records its cost so the
 * trade is visible at the point of choosing.
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
  /** Rough triangle count, for the console listing. Measured on load and logged precisely. */
  triangles: string;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: 'soldier-hd',
    label: 'Soldier (high detail)',
    /*
     * The three.js sample soldier. Considerably more geometry than the Quaternius set, properly rigged,
     * with idle, walk and run clips. Served from threejs.org, which sets permissive CORS because the
     * whole examples directory exists to be fetched cross-origin.
     */
    url: 'https://threejs.org/examples/models/gltf/Soldier.glb',
    author: 'three.js examples',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Most detailed. Idle, walk and run only, so combat poses fall back.',
    triangles: '~30k',
  },
  {
    id: 'xbot',
    label: 'X Bot',
    url: 'https://threejs.org/examples/models/gltf/Xbot.glb',
    author: 'Mixamo via three.js examples',
    licence: 'CC-BY 4.0',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf',
    note: 'Mixamo rig, so Mixamo clips retarget onto it. Robot, not human.',
    triangles: '~10k',
  },
  {
    id: 'swat',
    label: 'SWAT',
    url: 'https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/Btfn3G5Xv4',
    note: 'Tactical operator. 24 clips including aim, shoot and two flinches.',
    triangles: '~8k',
  },
  {
    id: 'soldier',
    label: 'Character Soldier',
    url: 'https://static.poly.pizza/1083c1d3-d1d4-4682-adf6-bc516d06ac84.glb',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/PpLF4rt4ah',
    note: 'Military figure with a full clip set.',
    triangles: '~8k',
  },
  {
    id: 'kolos',
    label: 'Soldier (KolosStudios)',
    url: 'https://static.poly.pizza/42b9173f-a91c-4abf-b6f5-b21a3965f61a.glb',
    author: 'KolosStudios',
    licence: 'CC-BY 3.0',
    source: 'https://poly.pizza/m/XT8jgwSesV',
    note: 'Different artist, different silhouette.',
    triangles: '~6k',
  },
  {
    id: 'local',
    label: 'Local file',
    url: null,
    author: 'whatever you put there',
    licence: 'yours to check',
    source: 'apps/client/public/models/soldier.glb',
    note: 'Loads only when selected. Drop any rigged .glb at that path.',
    triangles: 'varies',
  },
];

/**
 * Default.
 *
 * SWAT rather than the highest-detail option: it has 24 animation clips against the high-detail
 * soldier's three, and aim, shoot, strafe and flinch poses do more for how a figure reads in a firefight
 * than four times the triangles. Switch with rearena.model('soldier-hd') to compare.
 */
export const DEFAULT_MODEL_ID = 'swat';

export function modelById(id: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((m) => m.id === id);
}
