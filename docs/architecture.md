# RE:Arena architecture (summary)

Full blueprints live in Software Factory. This file is the short version for people reading the repo.

## Containers

1. Game Client (`apps/client`): Vite + React + Babylon.js. Sim runs in a Web Worker at 60 Hz; renderer interpolates snapshots. Records every InputFrame into a RunLog.
2. Sim Core (`packages/sim`): deterministic gameplay. Pure TypeScript, fixed-point math, seeded PRNG, own collision. Same code in browser and Node.
3. Backend (Supabase): Auth (anonymous guests upgradeable), Postgres + RLS, Storage (runs, ghosts, content), Edge Functions (submit-run, rotate-daily-challenge, admin-content-publish), pg_cron.
4. Verifier (`apps/verifier`): Node worker. Claims verification_jobs, replays RunLog through Sim Core, compares every StateHash checkpoint, commits leaderboard/challenge/ghost/xp in one transaction.
5. Content Pipeline (`tools/asset-pipeline`): glTF optimisation, KTX2 textures, collision export, hashed bundles, ContentManifest, publish.

## Key flows

- Play: manifest -> map bundle by hash -> sim with seed -> record inputs -> local result -> submit -> pending -> verified rank.
- Daily challenge: pg_cron creates tomorrow's seed; attempt is consumed at start (start_challenge_attempt RPC).
- Ghost: leaderboard row -> GhostLog -> second sim instance tick-locked to the live sim -> translucent player.

## Determinism

No Math.random / Date / timers / transcendental built-ins in `packages/sim` (enforced by ESLint). StateHash every 60 ticks. Golden replays run in Node and Chromium in CI. Any outcome-changing edit bumps SIM_VERSION; boards are keyed by it.
