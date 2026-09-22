/**
 * Model URL probe.
 *
 * Answers two questions for every catalogue entry: does this URL serve a glTF this browser can read, and
 * what animations does it contain?
 *
 * This exists because it cannot be answered anywhere else. A page-fetching tool cannot read a binary
 * response, so a `.glb` URL looks empty whether it is valid or missing. The browser is the only thing that
 * can check, and it is also the thing that has to fetch these at runtime, so its verdict is the one that
 * counts.
 *
 * The second question matters more than the first. A reachable model with no skeleton loads without error
 * and then stands perfectly still, which reads as a broken animation system rather than as the wrong asset.
 * Reading the clip names up front turns that into a fact printed at load.
 *
 * ## Reading only what is needed
 *
 * A glTF binary is a 12-byte header, then a length-prefixed JSON chunk describing the whole scene, then the
 * geometry buffer. The JSON chunk declares its own length at byte 12, so the entire scene description can
 * be read and the buffer skipped: tens of kilobytes instead of several megabytes per model.
 */

import { MODEL_OPTIONS, type ModelOption } from './model-catalogue.js';

/** glTF binary files begin with the ASCII magic "glTF", read as a little-endian uint32. */
const GLTF_MAGIC = 0x46546c67;
/** Chunk type tag for the JSON chunk: ASCII "JSON". */
const CHUNK_JSON = 0x4e4f534a;
/** Header is 12 bytes, then each chunk has an 8-byte length and type prefix. */
const HEADER_BYTES = 12;
const CHUNK_PREFIX_BYTES = 8;
/**
 * Ceiling on the JSON chunk read. A scene description above this is not a character; refusing to read
 * further keeps a pathological file from pulling down megabytes during a probe.
 */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export type ProbeVerdict = 'ok' | 'not-gltf' | 'unreachable' | 'skipped';

/** The logical states the game asks for, and the clip-name fragments that satisfy each. */
const WEAPON_CLIP_HINTS = ['gun', 'aim', 'shoot', 'fire', 'rifle', 'attack'];
const LOCOMOTION_CLIP_HINTS = ['walk', 'run', 'sprint', 'jog'];
const DIRECTIONAL_CLIP_HINTS = ['_back', '_left', '_right', 'strafe'];
const REACTION_CLIP_HINTS = ['hit', 'death', 'die', 'damage', 'flinch'];

export interface ProbeResult {
  option: ModelOption;
  verdict: ProbeVerdict;
  /** glTF container version, when readable. 2 for everything current. */
  version?: number;
  /** Animation names found in the file. */
  clips?: string[];
  /** Skinned meshes. Zero means the model cannot be skeletally animated. */
  skinCount?: number;
  meshCount?: number;
  /** True when at least one clip name suggests a weapon pose. */
  hasWeaponClips?: boolean;
  hasLocomotion?: boolean;
  hasDirectional?: boolean;
  hasReactions?: boolean;
  detail?: string;
}

interface GltfHeader {
  magic: number;
  version: number;
  jsonLength: number;
}

/** Minimal shape of the parts of a glTF JSON chunk this probe reads. */
interface GltfJson {
  animations?: { name?: string }[];
  skins?: unknown[];
  meshes?: unknown[];
}

function readHeader(bytes: Uint8Array): GltfHeader | null {
  if (bytes.byteLength < HEADER_BYTES + CHUNK_PREFIX_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  // A first chunk that is not JSON means this is not a glTF the spec allows.
  if (chunkType !== CHUNK_JSON) return { magic, version, jsonLength: 0 };
  return { magic, version, jsonLength: chunkLength };
}

/**
 * Read the header and JSON chunk, then stop.
 *
 * Chunks are accumulated only until the declared JSON length is covered, and the stream is cancelled after
 * that. A Range header would be tidier but not every CDN honours one, and a rejected range returns the
 * whole file, which defeats the point.
 */
async function readSceneJson(
  url: string,
): Promise<{ header: GltfHeader; json: GltfJson | null } | null> {
  const response = await fetch(url, { method: 'GET', mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = response.body;
  if (!body) {
    // No streaming support. Full read, because correctness beats economy on a one-off probe.
    const buffer = new Uint8Array(await response.arrayBuffer());
    const header = readHeader(buffer);
    if (!header) return null;
    return { header, json: decodeJson(buffer, header) };
  }

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let header: GltfHeader | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      total += value.byteLength;

      // Header first, so the JSON length is known and the read can stop at the right place.
      if (!header && total >= HEADER_BYTES + CHUNK_PREFIX_BYTES) {
        header = readHeader(concat(parts, total));
        if (!header || header.magic !== GLTF_MAGIC) break;
        if (header.jsonLength > MAX_JSON_BYTES) break;
      }

      if (header && total >= HEADER_BYTES + CHUNK_PREFIX_BYTES + header.jsonLength) break;
      // Guard against a stream that never satisfies the above because the header was unreadable.
      if (!header && total > 64 * 1024) break;
    }
  } finally {
    // Releases the connection without downloading the geometry buffer.
    await reader.cancel().catch(() => {});
  }

  const bytes = concat(parts, total);
  header ??= readHeader(bytes);
  if (!header) return null;
  return { header, json: decodeJson(bytes, header) };
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function decodeJson(bytes: Uint8Array, header: GltfHeader): GltfJson | null {
  if (header.jsonLength === 0) return null;
  const start = HEADER_BYTES + CHUNK_PREFIX_BYTES;
  const end = start + header.jsonLength;
  if (bytes.byteLength < end) return null;
  try {
    const text = new TextDecoder().decode(bytes.subarray(start, end));
    return JSON.parse(text) as GltfJson;
  } catch {
    // A truncated or malformed chunk is not worth distinguishing from an absent one here.
    return null;
  }
}

/** Does any clip name contain one of these fragments? */
function matchesAny(clips: readonly string[], hints: readonly string[]): boolean {
  return clips.some((clip) => {
    const lower = clip.toLowerCase();
    return hints.some((hint) => lower.includes(hint));
  });
}

async function probeOne(option: ModelOption): Promise<ProbeResult> {
  if (option.url === null) {
    // The local file is a user-supplied path; probing it says nothing about the catalogue.
    return { option, verdict: 'skipped', detail: 'local file, select it to test' };
  }

  try {
    const read = await readSceneJson(option.url);
    if (!read) {
      return { option, verdict: 'not-gltf', detail: 'response too short to be a glTF' };
    }
    if (read.header.magic !== GLTF_MAGIC) {
      /*
       * Almost always an HTML error page served with a 200, which is how a CDN reports a missing asset when
       * the path pattern is wrong.
       */
      return { option, verdict: 'not-gltf', detail: 'not a binary glTF (likely an HTML page)' };
    }

    const json = read.json;
    if (!json) {
      // Reachable and valid, but the scene description could not be read. Still usable by the loader.
      return {
        option,
        verdict: 'ok',
        version: read.header.version,
        detail: 'scene description unreadable, clips unknown',
      };
    }

    const clips = (json.animations ?? [])
      .map((a, i) => a.name ?? `unnamed-${i}`)
      .filter((n) => n.length > 0);

    return {
      option,
      verdict: 'ok',
      version: read.header.version,
      clips,
      skinCount: json.skins?.length ?? 0,
      meshCount: json.meshes?.length ?? 0,
      hasWeaponClips: matchesAny(clips, WEAPON_CLIP_HINTS),
      hasLocomotion: matchesAny(clips, LOCOMOTION_CLIP_HINTS),
      hasDirectional: matchesAny(clips, DIRECTIONAL_CLIP_HINTS),
      hasReactions: matchesAny(clips, REACTION_CLIP_HINTS),
    };
  } catch (error) {
    // Covers 404s, DNS failures and CORS rejections alike; from here they are the same problem.
    return {
      option,
      verdict: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Probe every catalogue entry.
 *
 * Concurrent, because 22 sequential round trips is a slow way to answer a simple question. The list is small
 * and fixed, so there is no need to limit concurrency.
 */
export async function probeAllModels(): Promise<ProbeResult[]> {
  return Promise.all(MODEL_OPTIONS.map((option) => probeOne(option)));
}

/** Probe a single entry by id, for checking one model without waiting on all of them. */
export async function probeModel(id: string): Promise<ProbeResult | null> {
  const option = MODEL_OPTIONS.find((m) => m.id === id);
  return option ? probeOne(option) : null;
}

/**
 * Format results for the console.
 *
 * Sorted by usefulness rather than by name: a model with weapon poses is worth more to a shooter than one
 * with more clips overall, so that column leads.
 */
export function formatProbeResults(results: readonly ProbeResult[]): string {
  const score = (r: ProbeResult): number => {
    if (r.verdict !== 'ok') return -1;
    if (r.skinCount === 0) return 0;
    return (
      (r.hasWeaponClips ? 8 : 0) +
      (r.hasDirectional ? 4 : 0) +
      (r.hasReactions ? 2 : 0) +
      (r.hasLocomotion ? 1 : 0)
    );
  };

  const sorted = [...results].sort((a, b) => score(b) - score(a));

  const lines = sorted.map((r) => {
    if (r.verdict === 'skipped') return `SKIP  ${r.option.id.padEnd(20)} ${r.detail ?? ''}`;
    if (r.verdict !== 'ok') return `FAIL  ${r.option.id.padEnd(20)} ${r.detail ?? ''}`;

    if (r.clips === undefined) {
      return `OK    ${r.option.id.padEnd(20)} reachable, clips unknown`;
    }

    // The important warning: no skin means no skeletal animation, whatever the clip count says.
    if (r.skinCount === 0) {
      return `STATIC ${r.option.id.padEnd(19)} no skinned mesh: this model cannot animate`;
    }

    const features = [
      r.hasWeaponClips ? 'gun' : null,
      r.hasLocomotion ? 'move' : null,
      r.hasDirectional ? 'strafe' : null,
      r.hasReactions ? 'hit/death' : null,
    ]
      .filter((f): f is string => f !== null)
      .join(' ');

    return `OK    ${r.option.id.padEnd(20)} ${String(r.clips.length).padStart(2)} clips  ${features}`;
  });

  const armed = sorted
    .filter((r) => r.verdict === 'ok' && r.hasWeaponClips && (r.skinCount ?? 0) > 0)
    .map((r) => r.option.id);
  const animated = sorted.filter((r) => r.verdict === 'ok' && (r.skinCount ?? 0) > 0).length;
  const statics = sorted.filter((r) => r.verdict === 'ok' && r.skinCount === 0).length;

  return [
    `Probed ${results.length}: ${animated} animated, ${statics} static, ` +
      `${results.filter((r) => r.verdict === 'unreachable' || r.verdict === 'not-gltf').length} failed.`,
    '',
    ...lines,
    '',
    armed.length > 0
      ? `With weapon poses: ${armed.join(', ')}`
      : 'None have weapon poses. Retarget clips from Mixamo, or keep the procedural weapon.',
    '',
    "Inspect one model's clip names with rearena.clips('swat').",
  ].join('\n');
}

/** Full clip list for one model, for wiring the matcher against a specific file. */
export function formatClipList(result: ProbeResult): string {
  if (result.verdict !== 'ok') {
    return `${result.option.label}: ${result.verdict} ${result.detail ?? ''}`;
  }
  if (!result.clips) return `${result.option.label}: clips unknown`;
  if (result.clips.length === 0) {
    return `${result.option.label}: no animation clips in the file`;
  }
  return [
    `${result.option.label} by ${result.option.author} (${result.option.licence})`,
    `${result.meshCount ?? 0} meshes, ${result.skinCount ?? 0} skins, ${result.clips.length} clips:`,
    '',
    ...result.clips.map((c) => `  ${c}`),
  ].join('\n');
}
