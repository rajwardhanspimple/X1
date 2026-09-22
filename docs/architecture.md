# RE:Arena architecture (summary)

Full blueprints live in Software Factory. This file is the short version for people reading the repo.

## Containers

1. Game Client (`apps/client`): Vite + React + Babylon.js, deployed as Cloudflare Workers Static Assets. Sim runs in a Web Worker at 60 Hz; renderer interpolates snapshots. Records every InputFrame into a RunLog.
2. Sim Core (`packages/sim`): deterministic gameplay. Pure TypeScript, fixed-point math, seeded PRNG, own collision. Same code in browser and Node. Replay at least 100x real time.
3. Backend (Supabase free plan): Auth (anonymous guests upgradeable), Postgres + RLS, Storage (runs, ghosts), Edge Functions (submit-run, rotate-daily-challenge, admin-content-publish, delete-account), pg_cron, and a Database Webhook that pushes verification jobs to the verifier.
4. Verifier (`apps/verifier`): Vercel Hobby serverless function at `POST /api/verify`. Claims the job with a conditional UPDATE, replays the RunLog through Sim Core, compares every StateHash checkpoint, commits results through the `commit_verification` RPC. A pg_cron reconciler re-fires stuck jobs.
5. Content Pipeline (`tools/asset-pipeline`): glTF optimisation, KTX2 textures, collision export, hashed bundles, ContentManifest. Publishes to the `rearena-content` Cloudflare static project (unmetered bandwidth); Postgres holds the release pointer.

## Key flows

- Play: release pointer -> manifest -> map bundle by hash from the content host -> sim with seed -> record inputs -> local result -> submit -> pending -> webhook wakes verifier -> verified rank (3 to 5 s).
- Daily challenge: pg_cron creates tomorrow's seed; attempt is consumed at start (start_challenge_attempt RPC).
- Ghost: leaderboard row -> GhostLog from Supabase Storage -> second sim instance tick-locked to the live sim -> translucent player.

## Determinism

No Math.random / Date / timers / transcendental built-ins in `packages/sim` (enforced by ESLint). StateHash every 60 ticks. Golden replays run in Node and Chromium in CI. Any outcome-changing edit bumps SIM_VERSION; boards are keyed by it.

## Cost

Zero. See `docs/environments.md` for each free tier and its first ceiling.
