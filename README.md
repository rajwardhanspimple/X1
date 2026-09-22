# RE:Arena

Browser-based 3D first-person shooter with asynchronous competition: global leaderboards, a daily challenge with one shared seed, and ghost replays. Every run is recorded as inputs and replayed server-side through the same deterministic simulation before it is ranked.

## Stack

- Client: Vite, TypeScript, React, Tailwind CSS, Babylon.js (WebGPU with WebGL2 fallback). Simulation runs in a Web Worker at 60 Hz. Hosted on Cloudflare Workers Static Assets.
- Sim Core: pure TypeScript deterministic simulation (`packages/sim`), shared by the client and the verifier.
- Backend: Supabase (Auth, Postgres with RLS, Storage, Edge Functions, pg_cron). The verifier is the `verify-run` Edge Function, replaying runs in slices to fit the free-plan CPU cap.
- Content: hashed asset bundles and a versioned manifest produced by `tools/asset-pipeline`, hosted on a second Cloudflare static project.
- Cost: zero. Two vendors, both on free plans.

## Layout

```
apps/
  client/            Game client (Vite + React + Babylon)
packages/
  sim/               Deterministic simulation core
  protocol/          Shared types: MatchConfig, InputFrame, RunLog, RunSubmission, API shapes
  content-schema/    Zod schemas for maps, modes, weapons, enemies, medals, manifest
  ui/                Shared React components and design tokens
content/             Source content (maps, weapons, modes, enemies, medals)
supabase/
  migrations/        Forward-only SQL
  functions/         Edge Functions incl. verify-run (the verifier)
  seed/              Local seed
tools/
  asset-pipeline/    glTF optimisation, KTX2, collision export, manifest, publish
e2e/                 Playwright smoke tests (desktop + mobile emulation)
docs/                architecture.md, environments.md
```

## Requirements

- Node 22 or newer (`.nvmrc`)
- pnpm 9 (`corepack enable`)
- Supabase CLI (for local backend and Edge Functions)
- Wrangler (for Cloudflare deploys; installed as a dev dependency)

## Getting started

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @rearena/client dev
```

## Environment

Copy `apps/client/.env.example` to `apps/client/.env.local` and fill in the public values. Secrets (service role key, database password, webhook secret) are never committed; see `docs/environments.md`.

## Determinism rules

Gameplay code in `packages/sim` must not use `Math.random`, `Date`, `performance`, timers, or built-in transcendental functions. Use `SeededRandom` and `FixedMath`. Any change that alters an outcome for the same inputs increments `simVersion`. State must stay fully serialisable.

## Project management

Requirements, blueprints, and work orders live in Software Factory (project RS, feature tree `RE:Arena Match`).
