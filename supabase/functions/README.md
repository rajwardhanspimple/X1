# Edge Functions

Deno functions. The verifier is the one that matters; the rest are planned.

| Function | Status | Purpose |
| --- | --- | --- |
| `verify-run` | **implemented** (WO-38) | Replays a submitted run in slices and commits or rejects it |
| `submit-run` | not built | Currently handled client-side by `RunSubmitter` writing to Storage and `runs` |
| `rotate-daily-challenge` | not built (WO-44) | Picks the day's seed, map and mode |
| `admin-content-publish` | not built (WO-8) | Promotes a content release |
| `delete-account` | not built (WO-28) | Cascades profile deletion and revokes sessions |

## Build before deploying

**This is required, not optional.** The shared packages must be compiled first:

```sh
pnpm --filter @rearena/protocol --filter @rearena/content-schema --filter @rearena/sim build
supabase functions deploy verify-run
```

Or in one step, which runs the build for you:

```sh
pnpm functions:deploy
```

### Why

The shared packages use NodeNext module resolution, so every internal import is written with a `.js` extension:

```ts
import { raycast } from './collision.js';   // resolves to collision.ts under NodeNext
```

TypeScript rewrites that back to the `.ts` source. **Deno does not.** It fetches the literal path, finds no emitted
JavaScript, and the deploy fails with `Module not found ... kernel.js` after uploading everything.

So `import_map.json` points at `packages/*/dist`, which only exists after a build. Skipping the build produces a 400
at the end of a long upload with a message that does not name the real cause.

The alternative was making every internal import extensionless, which would break Node's ESM resolution in the client
build and the test runner. Building the package is the smaller change.

## Secrets

```sh
supabase secrets set VERIFIER_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically and must not be set by hand.

## Wiring the verifier

After deploying, create a Database Webhook so a submitted run triggers verification:

- Dashboard > Database > Webhooks > Create
- Table `public.runs`, event **INSERT**
- Type: Supabase Edge Function, function `verify-run`
- HTTP header `x-verifier-secret` with the value from `secrets set`

The function also accepts `{ "job_id": "..." }`, which is how it chains itself between slices.

## Local development

```sh
supabase functions serve verify-run --no-verify-jwt
```

Requires Docker. Without it, `supabase functions deploy` still works (it builds server-side) but `serve` does not.
