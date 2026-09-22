# RE:Arena architecture (summary)

Full blueprints live in Software Factory. This file is the short version for people reading the repo.

## Containers

1. Game Client (`apps/client`): Vite + React + Babylon.js, deployed as Cloudflare Workers Static Assets. Sim runs in a Web Worker at 60 Hz; renderer interpolates snapshots. Records every InputFrame into a RunLog.
2. Sim Core (`packages/sim`): deterministic gameplay. Pure TypeScript, fixed-point math, seeded PRNG, own collision. Same code in browser, Node, and Deno. Replay at least 100x real time. State is fully serialisable (`serializeState` / `restoreState`) so a replay can be split into slices.
3. Backend (Supabase free plan): Auth (anonymous guests upgradeable), Postgres + RLS, Storage (runs, ghosts), Edge Functions (submit-run, verify-run, rotate-daily-challenge, admin-content-publish, delete-account), pg_cron, and a Database Webhook that starts verification.
4. Verifier (`supabase/functions/verify-run`): Edge Function. Because the free plan caps CPU at 2 s per call, each call replays one slice (~6,000 ticks), saves SimState on the job row, and chains the next call through the `advance_verification` RPC. Compares every StateHash checkpoint, commits results through `commit_verification`. A pg_cron reconciler re-fires stuck jobs.
5. Content Pipeline (`tools/asset-pipeline`): glTF optimisation, KTX2 textures, collision export, hashed bundles, ContentManifest. Publishes to the `rearena-content` Cloudflare static project (unmetered bandwidth); Postgres holds the release pointer.

## Key flows

- Play: release pointer -> manifest -> map bundle by hash from the content host -> sim with seed -> record inputs -> local result -> submit -> pending -> webhook starts verify-run -> 3 to 4 slices -> verified rank (5 to 8 s).
- Daily challenge: pg_cron creates tomorrow's seed; attempt is consumed at start (start_challenge_attempt RPC).
- Ghost: leaderboard row -> GhostLog from Supabase Storage -> second sim instance tick-locked to the live sim -> translucent player.

## Determinism

No Math.random / Date / timers / transcendental built-ins in `packages/sim` (enforced by ESLint). StateHash every 60 ticks. Golden replays run in Node and Chromium in CI. Any outcome-changing edit bumps SIM_VERSION; boards are keyed by it.

## Cost

Zero. Two vendors: Supabase and Cloudflare. See `docs/environments.md` for each free tier and its first ceiling.
