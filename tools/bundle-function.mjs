#!/usr/bin/env node
/**
 * Bundle an Edge Function for deployment.
 *
 * ## Why esbuild rather than tsc
 *
 * `tsc -p packages/sim` emits nothing. The base config sets `moduleResolution: "Bundler"`, which TypeScript only allows
 * together with `noEmit`, because tsc cannot reproduce a bundler's resolution rules. That setting is deliberate: it is
 * what lets the source mix extensionless imports with `.js`-suffixed ones and have Vite and Vitest resolve both.
 *
 * Deno needs real JavaScript with paths that exist. esbuild resolves imports exactly as the bundler does and inlines
 * every workspace package into one file, which means the deployed function has no cross-package paths to resolve and
 * the import map shrinks to third-party modules only.
 *
 * The alternative was converting the whole repository to NodeNext and adding explicit extensions to every import, to
 * satisfy one deploy target. This is the smaller change.
 *
 * ## What stays external
 *
 * supabase-js is left as a bare import so Deno pulls it from npm at deploy time. Bundling it would inline a large
 * dependency that the Edge runtime already caches, and `npm:` specifiers are the documented way to depend on it.
 *
 *   node tools/bundle-function.mjs verify-run
 */

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const name = process.argv[2];
if (!name) {
  console.error('usage: node tools/bundle-function.mjs <function-name>');
  process.exit(1);
}

const entry = join(root, 'supabase/functions', name, 'index.ts');
const outDir = join(root, 'supabase/functions', `${name}-bundled`);
const outFile = join(outDir, 'index.ts');

await mkdir(outDir, { recursive: true });

try {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    // Deno supports current syntax, so there is no reason to downlevel and obscure the output.
    target: 'es2022',
    /*
     * Left for Deno to fetch. Bundling supabase-js would inline a large dependency the Edge runtime already caches, and
     * `npm:` specifiers are the documented way to depend on it. Deno's own globals are obviously external too.
     */
    external: ['@supabase/supabase-js', 'npm:*', 'node:*', 'https://*'],
    // Keeps the deployed output readable, which matters when the only debugging channel is a log line.
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
  });

  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild produced no output');

  /*
   * Written as .ts rather than .js so the Supabase CLI treats it as a function entry point. The contents are plain
   * JavaScript, which is valid TypeScript, and Deno type-checks it as such.
   */
  const banner = [
    '// GENERATED FILE. Do not edit.',
    `// Bundled from supabase/functions/${name}/index.ts by tools/bundle-function.mjs.`,
    '//',
    '// Workspace packages are inlined because Deno cannot resolve the .js-suffixed imports that the',
    '// source uses; see the note at the top of the bundler script.',
    '',
  ].join('\n');

  await writeFile(outFile, banner + new TextDecoder().decode(output.contents), 'utf8');

  const kb = Math.round(output.contents.byteLength / 1024);
  console.log(`bundled ${name}: ${kb} KB -> supabase/functions/${name}-bundled/index.ts`);
} catch (error) {
  console.error(`failed to bundle ${name}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}
