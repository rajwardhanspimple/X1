# RE:Arena

Browser-based 3D arena shooter. Three-minute rounds, global leaderboards, a daily challenge on one
shared seed, and ghost replays. Desktop and mobile, no install.

## Running it

```sh
corepack enable
pnpm install
pnpm --filter @rearena/client dev
```

Opens on http://127.0.0.1:5173. Add `-- --host` to reach it from a phone on the same network.

```sh
pnpm test        # determinism suite
pnpm typecheck
pnpm lint
```

## Character models (optional)

The game ships with procedurally built figures so it runs on a fresh clone with nothing downloaded.
For better-looking characters, fetch the CC0 models:

```sh
node tools/fetch-models.mjs
```

That downloads rigged, animated glTF models into `apps/client/public/models/` and writes a
`CREDITS.md` alongside them. The directory is gitignored: binaries bloat git history permanently, and
a clone should not need megabytes to start.

To use your own model instead, drop a rigged `.glb` at `apps/client/public/models/soldier.glb`. The
loader scales it to the simulation's 1.8-unit hitbox automatically and matches animation clips by
name, case-insensitively, looking for `idle`, `walk`, `run`, `aim`, `shoot`, `death` and `hit`
anywhere in a clip's name. Clip names are logged to the console on load, so a model whose clips are
named differently is easy to diagnose.

## Architecture

The simulation is deterministic and runs in a Web Worker at a fixed 60 Hz. It uses Q16.16 fixed-point
math and a seeded PRNG, never `Math.random`, `Date`, or IEEE transcendentals, so the same inputs
produce the same outcome on every device. That is what makes a run verifiable: the server replays the
recorded inputs and compares state hashes.

Everything visual is presentation only and cannot affect a run. Quality tiers, camera shake, view
bob, animation and frame rate caps all sit outside the simulation boundary by construction.

- `packages/sim` deterministic simulation. No DOM, no Node; runs in the browser, in Node for tests,
  and in Deno inside the verifier.
- `packages/protocol` shared wire types.
- `apps/client` Babylon.js renderer, input, HUD and screens.
- `supabase/` database schema, RLS policies and the `verify-run` Edge Function.

See `docs/architecture.md` for detail and `docs/environments.md` for hosting.

## Hosting

Everything runs on free tiers: Cloudflare Workers Static Assets for the client and content,
Supabase free for auth, Postgres, storage and the verifier Edge Function.
