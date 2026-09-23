/**
 * Supabase browser client.
 *
 * One instance for the whole app. Multiple clients would each run their own token refresh timer and race to
 * write the same storage key, which produces sessions that expire for no visible reason.
 *
 * ## Why "unconfigured" is a real state rather than an error
 *
 * Vite replaces an unset `import.meta.env.VITE_FOO` with the empty string. `createClient('', '')` returns a
 * working object, and every call it makes then fails with an opaque network error. The game appears broken and
 * the console does not say why.
 *
 * So missing credentials are detected up front and reported as a condition the UI can act on: the menu shows
 * "offline, progress saves locally" rather than a sign-in button that cannot succeed. This is also the state on
 * a fresh clone, which should run the game rather than refuse to start.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Storage key for the persisted session.
 *
 * Named rather than left to the default so that changing it later is a deliberate migration. The default key
 * embeds the project ref, and a silent change signs every player out at once with no explanation.
 */
const STORAGE_KEY = 'rearena.auth.v1';

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** Why the backend is unavailable, when it is. */
export type BackendUnavailableReason = 'missing-url' | 'missing-key' | 'invalid-url';

function describeConfig(): BackendUnavailableReason | null {
  if (url.trim() === '') return 'missing-url';
  if (anonKey.trim() === '') return 'missing-key';
  if (!/^https?:\/\//.test(url)) return 'invalid-url';
  return null;
}

const configProblem = describeConfig();

/**
 * The client, or null when the app is not configured for a backend.
 *
 * Callers must handle null. That is deliberate: making this non-null with a stub would let calling code assume
 * a backend exists, and the resulting failures would surface deep inside gameplay rather than at the boundary.
 */
export const supabase: SupabaseClient | null =
  configProblem === null
    ? createClient(url, anonKey, {
        auth: {
          // A guest session must survive a reload, or progress restarts on every visit.
          persistSession: true,
          autoRefreshToken: true,
          storageKey: STORAGE_KEY,
          /*
           * The OAuth callback arrives as a URL fragment. Detecting it here is what completes a provider
           * sign-in after the redirect; without it the player returns to the page still signed out.
           */
          detectSessionInUrl: true,
          flowType: 'pkce',
        },
        global: {
          headers: { 'x-client-info': `rearena/${import.meta.env.VITE_BUILD_ID ?? 'dev'}` },
        },
      })
    : null;

export function isBackendConfigured(): boolean {
  return supabase !== null;
}

export function backendUnavailableReason(): BackendUnavailableReason | null {
  return configProblem;
}

/** Player-facing explanation for an unconfigured backend. */
export function describeUnavailable(reason: BackendUnavailableReason): string {
  switch (reason) {
    case 'missing-url':
    case 'missing-key':
      return 'Playing offline. Scores and progress are saved on this device only.';
    case 'invalid-url':
      return 'The server address is not valid. Playing offline.';
  }
}

/** Log the configuration state once at boot, so a misconfiguration is visible without reading code. */
export function logBackendState(): void {
  if (configProblem === null) {
    const host = url.replace(/^https?:\/\//, '').split('.')[0];
    console.info(`[rearena] backend configured: ${host}`);
    return;
  }
  console.info(
    `[rearena] no backend (${configProblem}): running offline. ` +
      'See docs/supabase-setup.md, then run node tools/check-env.mjs',
  );
}
