#!/usr/bin/env node
/**
 * Environment doctor.
 *
 * Reports what is configured and what is missing, because the failure mode otherwise is quiet and
 * confusing: Vite replaces an unset `import.meta.env.VITE_FOO` with the empty string rather than
 * raising, so the client builds cleanly, runs, and then sign-in does nothing at all. A missing
 * variable should be a message at setup time, not a dead button discovered later.
 *
 * Read-only. It never writes a file and never prints a secret value, only whether one is present and
 * whether it has a plausible shape.
 *
 *   node tools/check-env.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, 'apps/client/.env.local');

const PASS = '  ok  ';
const FAIL = ' FAIL ';
const WARN = ' warn ';

let failures = 0;
let warnings = 0;

function report(status, label, detail = '') {
  if (status === FAIL) failures += 1;
  if (status === WARN) warnings += 1;
  console.log(`${status} ${label}${detail ? ` \u2014 ${detail}` : ''}`);
}

/** Parse a dotenv file well enough for KEY=value lines. Not a general implementation. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes, which dotenv tolerates and people often add.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

console.log('RE:Arena environment check\n');

if (!existsSync(envPath)) {
  report(FAIL, 'apps/client/.env.local', 'missing');
  console.log('\n  cp apps/client/.env.example apps/client/.env.local\n');
  process.exit(1);
}

const env = parseEnv(readFileSync(envPath, 'utf8'));

// --- Supabase URL ------------------------------------------------------------------------------
const url = env.VITE_SUPABASE_URL ?? '';

if (url === '') {
  report(FAIL, 'VITE_SUPABASE_URL', 'empty');
} else if (!/^https?:\/\//.test(url)) {
  report(FAIL, 'VITE_SUPABASE_URL', 'must start with http:// or https://');
} else if (url.endsWith('/')) {
  // Worth flagging: a trailing slash produces double-slash request paths, which some routes reject.
  report(WARN, 'VITE_SUPABASE_URL', 'remove the trailing slash');
} else if (url.includes('127.0.0.1') || url.includes('localhost')) {
  report(PASS, 'VITE_SUPABASE_URL', 'local Supabase');
} else if (url.includes('.supabase.co')) {
  const ref = url.replace(/^https?:\/\//, '').split('.')[0];
  report(PASS, 'VITE_SUPABASE_URL', `project ${ref}`);
} else {
  report(WARN, 'VITE_SUPABASE_URL', 'not a recognised Supabase host');
}

// --- Anonymous key -----------------------------------------------------------------------------
const key = env.VITE_SUPABASE_ANON_KEY ?? '';
if (key === '') {
  report(FAIL, 'VITE_SUPABASE_ANON_KEY', 'empty');
} else if (key.startsWith('sb_secret_')) {
  /*
   * The new-format secret key. Fails hard rather than warning: it bypasses row-level security exactly as a legacy service_role JWT
   * does, and it is the one key that cannot be allowed into a browser bundle.
   */
  report(
    FAIL,
    'VITE_SUPABASE_ANON_KEY',
    'this is a SECRET key (sb_secret_): it bypasses row-level security and must never ship to a browser. Use the publishable key.',
  );
} else if (key.startsWith('sb_publishable_')) {
  /*
   * The new anonymous key format. Not a JWT, so there is no role to decode; the prefix is the check, because only a publishable key
   * is safe here.
   */
  report(PASS, 'VITE_SUPABASE_ANON_KEY', 'publishable key (sb_publishable_)');
} else {
  /*
   * Legacy JWT format. Decode the payload to check the role: this is the check worth having, because pasting the service role key
   * here is an easy mistake, it works in testing, and it ships full database access to every player.
   */
  const parts = key.split('.');
  if (parts.length !== 3) {
    report(WARN, 'VITE_SUPABASE_ANON_KEY', 'not a JWT and not a publishable key; cannot verify it');
  } else {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') {
        report(
          FAIL,
          'VITE_SUPABASE_ANON_KEY',
          'this is the SERVICE ROLE key: it bypasses row-level security and must never ship to a browser. Rotate it and use the anon key.',
        );
      } else if (payload.role === 'anon') {
        report(PASS, 'VITE_SUPABASE_ANON_KEY', 'anon role');
      } else {
        report(WARN, 'VITE_SUPABASE_ANON_KEY', `unexpected role "${payload.role}"`);
      }
    } catch {
      report(WARN, 'VITE_SUPABASE_ANON_KEY', 'could not decode the payload');
    }
  }
}

// --- Content host ------------------------------------------------------------------------------
const content = env.VITE_CONTENT_BASE_URL ?? '';
if (content === '') {
  // Not a failure: the client falls back to the built-in greybox arena, which is the local default.
  report(PASS, 'VITE_CONTENT_BASE_URL', 'empty, using the built-in greybox arena');
} else if (!/^https?:\/\//.test(content)) {
  report(FAIL, 'VITE_CONTENT_BASE_URL', 'must start with http:// or https://');
} else {
  report(PASS, 'VITE_CONTENT_BASE_URL', content);
}

// --- Build id ----------------------------------------------------------------------------------
const build = env.VITE_BUILD_ID ?? '';
report(build === '' ? WARN : PASS, 'VITE_BUILD_ID', build === '' ? 'empty' : build);

// --- Supabase link state -----------------------------------------------------------------------
//
// The CLI writes supabase/.temp/project-ref after `supabase link`. Checking for it distinguishes
// "migrations not pushed" from "never linked", which are different problems with different fixes.
const linkedRef = join(root, 'supabase/.temp/project-ref');
if (existsSync(linkedRef)) {
  report(PASS, 'supabase link', readFileSync(linkedRef, 'utf8').trim());
} else {
  report(WARN, 'supabase link', 'not linked: run supabase link --project-ref nprfxnegcwqqpjasoxln');
}

console.log('');
if (failures > 0) {
  console.log(`${failures} problem(s) must be fixed before the backend will work.`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${warnings} warning(s). The client will run.`);
} else {
  console.log('Environment looks good.');
}
