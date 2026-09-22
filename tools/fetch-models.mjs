#!/usr/bin/env node
/**
 * Download CC0 character models into apps/client/public/models/.
 *
 * The repository deliberately holds no binary assets: they bloat git history permanently, and a
 * fresh clone should not need to pull megabytes to run. The client falls back to procedural figures
 * when a model is absent, so this script is an upgrade rather than a prerequisite.
 *
 * Each download is verified against the glTF magic number. A CDN that returns an HTML error page
 * would otherwise leave a small file named .glb that fails to parse much later with a confusing
 * message, and that failure is hard to trace back to a bad download.
 *
 * Usage:  node tools/fetch-models.mjs
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, '..', 'apps', 'client', 'public', 'models');

/**
 * Models to fetch.
 *
 * All from Quaternius, hosted by Poly Pizza. Rigged and animated, with clips the loader matches by
 * substring. Licences are recorded here because "where did this asset come from" is a question that
 * always gets asked later and is painful to answer retroactively.
 */
const MODELS = [
  {
    file: 'soldier.glb',
    url: 'https://static.poly.pizza/66a55d04-4286-44a3-b289-0d774c27db5b.glb',
    source: 'https://poly.pizza/m/oAArCNHjFB',
    author: 'Quaternius',
    licence: 'CC-BY 3.0',
    note: 'Rigged soldier, animated. Used for enemy figures.',
  },
];

/** glTF binary files begin with the ASCII magic "glTF". */
function isGlb(buffer) {
  if (buffer.byteLength < 12) return false;
  const view = new DataView(buffer.buffer, buffer.byteOffset, 12);
  // 0x46546C67 is "glTF" little-endian.
  return view.getUint32(0, true) === 0x46546c67;
}

async function alreadyPresent(path) {
  try {
    const info = await stat(path);
    return info.size > 1024;
  } catch {
    return false;
  }
}

async function fetchModel(model) {
  const target = join(outputDir, model.file);

  if (await alreadyPresent(target)) {
    console.log(`  skip   ${model.file} (already downloaded)`);
    return true;
  }

  process.stdout.write(`  fetch  ${model.file} ... `);
  try {
    const response = await fetch(model.url, { redirect: 'follow' });
    if (!response.ok) {
      console.log(`failed (HTTP ${response.status})`);
      return false;
    }

    const buffer = new Uint8Array(await response.arrayBuffer());

    if (!isGlb(buffer)) {
      // Almost always an HTML error page served with a 200 status.
      console.log(`failed (not a glTF binary, got ${buffer.byteLength} bytes)`);
      return false;
    }

    await writeFile(target, buffer);
    console.log(`ok (${(buffer.byteLength / 1024).toFixed(0)} KB)`);
    return true;
  } catch (error) {
    console.log(`failed (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

async function main() {
  console.log('RE:Arena character models');
  console.log(`  target ${outputDir}`);
  await mkdir(outputDir, { recursive: true });

  let ok = 0;
  for (const model of MODELS) {
    if (await fetchModel(model)) ok += 1;
  }

  // Attribution file, written alongside the models so the licences travel with them.
  const credits = [
    '# Character model credits',
    '',
    'Downloaded by tools/fetch-models.mjs. Not committed to the repository.',
    '',
    ...MODELS.flatMap((m) => [
      `## ${m.file}`,
      '',
      `- Author: ${m.author}`,
      `- Licence: ${m.licence}`,
      `- Source: ${m.source}`,
      `- ${m.note}`,
      '',
    ]),
  ].join('\n');
  await writeFile(join(outputDir, 'CREDITS.md'), credits);

  console.log('');
  if (ok === MODELS.length) {
    console.log('All models ready. Restart the dev server to pick them up.');
  } else {
    console.log(
      `${ok} of ${MODELS.length} downloaded. The game still runs: missing models fall back to procedural figures.`,
    );
  }
}

await main();
