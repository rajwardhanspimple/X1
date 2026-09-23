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
 * Deno needs real JavaScript with paths that exist. esbuild resolves imports the way the bundler does and inlines every
 * workspace package into one file, so the deployed function has no cross-package paths to resolve at all.
 *
 * ## Two resolution problems this solves
 *
 * **Workspace packages.** `supabase/functions` is not a workspace package, so pnpm never linked anything into a
 * node_modules there and a bare `@rearena/sim` has nothing to resolve through. The aliases below map each package name
 * straight to its source entry point.
 *
 * **The .js extensions.** Internal imports inside the packages are written `./collision.js`, which TypeScript and Vite
 * resolve back to `./collision.ts`. esbuild does not do that rewrite on its own, so the plugin below performs it. This
 * is the specific thing that makes bundling work where tsc refused to emit.
 *
 *   node tools/bundle-function.mjs verify-run
 */

import { build } from 'esbuild';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

/**
 * Workspace package entry points.
 *
 * Listed explicitly rather than parsed out of pnpm-workspace.yaml. Three packages, one line each, and a wrong path
 * fails loudly at bundle time instead of quietly resolving to something unintended.
 */
const alias = {
  '@rearena/sim': join(root, 'packages/sim/src/index.ts'),
  '@rearena/protocol': join(root, 'packages/protocol/src/index.ts'),
  '@rearena/content-schema': join(root, 'packages/content-schema/src/index.ts'),
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the repository's import conventions.
 *
 * Handles two cases esbuild does not by default:
 *
 *  - a bare workspace specifier, mapped through the alias table above
 *  - a relative `./x.js` that is really `./x.ts`, which is what NodeNext-style imports look like in source
 *
 * The `.js` rewrite checks the `.ts` file exists before redirecting, so a genuine `.js` file (none today, but the
 * tools directory is plain JavaScript) would still resolve normally rather than being sent to a missing `.ts`.
 */
const resolvePlugin = {
  name: 'rearena-resolve',
  setup(pluginBuild) {
    // Bare workspace specifiers.
    pluginBuild.onResolve({ filter: /^@rearena\// }, (args) => {
      const target = alias[args.path];
      return target ? { path: target } : undefined;
    });

    // Relative .js imports that are really .ts on disk.
    pluginBuild.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, async (args) => {
      const candidate = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      if (await exists(candidate)) return { path: candidate };
      return undefined;
    });
  },
};

await mkdir(outDir, { recursive: true });

try {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    // Deno supports current syntax, so downlevelling would only obscure the output.
    target: 'es2022',
    plugins: [resolvePlugin],
    /*
     * Left for Deno to fetch. Bundling supabase-js would inline a large dependency the Edge runtime already caches, and
     * `npm:` specifiers are the documented way to depend on it.
     */
    external: ['@supabase/supabase-js', 'npm:*', 'node:*', 'https://*'],
    // Readable output matters when a log line is the only debugging channel.
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
  });

  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild produced no output');

  /*
   * Written as .ts so the Supabase CLI treats it as a function entry point. The contents are plain JavaScript, which is
   * valid TypeScript.
   */
  const banner = [
    '// GENERATED FILE. Do not edit.',
    `// Bundled from supabase/functions/${name}/index.ts by tools/bundle-function.mjs.`,
    '//',
    '// Workspace packages are inlined because Deno cannot resolve the .js-suffixed imports the source',
    '// uses, and supabase/functions is outside the pnpm workspace so bare specifiers do not resolve',
    '// there either. See the note at the top of the bundler script.',
    '',
  ].join('\n');

  await writeFile(outFile, banner + new TextDecoder().decode(output.contents), 'utf8');

  const kb = Math.round(output.contents.byteLength / 1024);
  console.log(`bundled ${name}: ${kb} KB -> supabase/functions/${name}-bundled/index.ts`);
} catch (error) {
  console.error(`failed to bundle ${name}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}
