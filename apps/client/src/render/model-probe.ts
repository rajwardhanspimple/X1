/**
 * Model URL probe.
 *
 * Answers one question for every catalogue entry: does this URL actually serve a glTF file this browser can
 * read?
 *
 * This exists because it cannot be answered anywhere else. A page-fetching tool cannot read a binary
 * response, so a `.glb` URL looks empty whether it is valid or missing. The browser is the only thing that
 * can check, and it is also the thing that has to fetch these at runtime, so its verdict is the one that
 * matters.
 *
 * Two failure modes, both caught here:
 *
 *  - The URL does not exist, or the host blocks cross-origin reads. Either way the fetch fails or returns
 *    HTML, and the game falls back to the next candidate.
 *  - The URL exists and serves something that is not a glTF. A `.glb` that is actually an HTML error page
 *    fails later, deeper, with a confusing parser error.
 *
 * The probe reads the first 20 bytes and cancels the stream, so checking 22 models costs a few kilobytes
 * rather than downloading every one of them.
 */

import { MODEL_OPTIONS, type ModelOption } from './model-catalogue.js';

/** glTF binary files begin with the ASCII magic "glTF" followed by a little-endian version. */
const GLTF_MAGIC = 0x46546c67; // 'glTF' read as uint32 LE

export type ProbeVerdict = 'ok' | 'not-gltf' | 'unreachable' | 'skipped';

export interface ProbeResult {
  option: ModelOption;
  verdict: ProbeVerdict;
  /** glTF container version, when readable. 2 for everything current. */
  version?: number;
  detail?: string;
}

/**
 * Read enough of a response to identify it, then stop.
 *
 * A Range header would be tidier, but not every CDN honours it and a rejected range returns the whole file.
 * Cancelling the stream after the first chunk is universally supported and achieves the same thing.
 */
async function readMagic(url: string): Promise<{ magic: number; version: number } | null> {
  const response = await fetch(url, { method: 'GET', mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = response.body;
  if (!body) {
    // No streaming support. Fall back to a full read; correctness over economy.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 12) return null;
    const view = new DataView(buffer);
    return { magic: view.getUint32(0, true), version: view.getUint32(4, true) };
  }

  const reader = body.getReader();
  try {
    const { value } = await reader.read();
    if (!value || value.byteLength < 12) return null;
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return { magic: view.getUint32(0, true), version: view.getUint32(4, true) };
  } finally {
    // Releases the connection without downloading the rest of the file.
    await reader.cancel().catch(() => {});
  }
}

async function probeOne(option: ModelOption): Promise<ProbeResult> {
  if (option.url === null) {
    // The local file is a user-supplied path; probing it says nothing useful about the catalogue.
    return { option, verdict: 'skipped', detail: 'local file, select it to test' };
  }

  try {
    const header = await readMagic(option.url);
    if (!header) {
      return { option, verdict: 'not-gltf', detail: 'response too short to be a glTF' };
    }
    if (header.magic !== GLTF_MAGIC) {
      /*
       * Almost always an HTML error page served with a 200, which is how a CDN reports a missing asset
       * when the path pattern is wrong.
       */
      return { option, verdict: 'not-gltf', detail: 'not a binary glTF (likely an HTML page)' };
    }
    return { option, verdict: 'ok', version: header.version };
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
 * Concurrent, because 22 sequential round trips is a slow way to answer a simple question. The list is
 * small and fixed, so there is no need to limit concurrency.
 */
export async function probeAllModels(): Promise<ProbeResult[]> {
  return Promise.all(MODEL_OPTIONS.map((option) => probeOne(option)));
}

/** Format results for the console: working ones first, then a copyable list of the ids that work. */
export function formatProbeResults(results: readonly ProbeResult[]): string {
  const rank: Record<ProbeVerdict, number> = { ok: 0, 'not-gltf': 1, unreachable: 2, skipped: 3 };
  const sorted = [...results].sort((a, b) => rank[a.verdict] - rank[b.verdict]);

  const lines = sorted.map((result) => {
    const mark =
      result.verdict === 'ok'
        ? 'OK     '
        : result.verdict === 'skipped'
          ? 'SKIP   '
          : 'FAILED ';
    const tail = result.verdict === 'ok' ? '' : ` — ${result.detail ?? ''}`;
    return `${mark} ${result.option.id.padEnd(20)} ${result.option.label}${tail}`;
  });

  const working = sorted.filter((r) => r.verdict === 'ok').map((r) => r.option.id);
  const failed = sorted.filter((r) => r.verdict !== 'ok' && r.verdict !== 'skipped').length;

  return [
    `Probed ${results.length} models: ${working.length} reachable, ${failed} failed.`,
    '',
    ...lines,
    '',
    working.length > 0
      ? `Working: ${working.join(', ')}`
      : 'None reachable. Check the network tab for CORS errors.',
  ].join('\n');
}
