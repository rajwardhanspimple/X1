# Edge Functions

Deno functions. The verifier is the one that matters; the rest are planned.

| Function                 | Status                  | Purpose                                                                       |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------- |
| `verify-run`             | **implemented** (WO-38) | Replays a submitted run in slices and commits or rejects it                   |
| `submit-run`             | not built               | Currently handled client-side by `RunSubmitter` writing to Storage and `runs` |
| `rotate-daily-challenge` | not built (WO-44)       | Picks the day's seed, map and mode                                            |
| `admin-content-publish`  | not built (WO-8)        | Promotes a content release                                                    |
| `delete-account`         | not built (WO-28)       | Cascades profile deletion and revokes sessions                                |

## The verifier is deployed as `verify-run-bundled`

`verify-run/index.ts` is the source. It imports the workspace packages (`@rearena/sim`, `@rearena/protocol`), which Deno
cannot resolve: `supabase/functions` is outside the pnpm workspace, and the packages use `.js`-suffixed imports that point
at `.ts` files. `tools/bundle-function.mjs` uses esbuild to inline everything into
`verify-run-bundled/index.ts`, and that is what gets deployed:

```sh
pnpm functions:deploy
```

This bundles and deploys in one step. **Run it after every change to `packages/sim`.** The bundle carries its own copy
of `SIM_VERSION`, and a stale bundle rejects every new run as `unsupported_version`.

The function is deployed with `--no-verify-jwt`, so the database can call it through pg_net. It still rejects every
request without the `x-verifier-secret` header, and that header is the real guard.

The bundle is generated. Do not edit it; lint ignores it.

## Going live

In order. Each step depends on the one before it.

**1. Apply the migrations**

```sh
supabase link --project-ref nprfxnegcwqqpjasoxln
supabase db push
```

If the migrations were pasted into the SQL Editor instead, mark them applied so `db push` does not run them twice:

```sh
supabase migration repair --status applied <version> ...
```

**2. Set the secret**

```sh
supabase secrets set VERIFIER_WEBHOOK_SECRET=<a long random string>
```

Or Dashboard > Edge Functions > Secrets. On Windows, generate one in PowerShell with
`-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) })`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically. Do not set them yourself.

**3. Deploy**

```sh
pnpm functions:deploy
```

**4. Tell the database where the verifier is**

Dashboard > SQL Editor:

```sql
insert into public.verifier_config (function_url, webhook_secret)
values (
  'https://nprfxnegcwqqpjasoxln.supabase.co/functions/v1/verify-run-bundled',
  '<the secret from step 2>'
)
on conflict (id) do update
  set function_url = excluded.function_url,
      webhook_secret = excluded.webhook_secret,
      updated_at = now();
```

No Database Webhook is needed. The `runs_start_verification` trigger (migration `20260924010000`) posts each new run to
the verifier with this URL and secret. The dashboard webhook failed on this project with "schema supabase_functions does
not exist", and a trigger in a migration is easier to keep in step with the code anyway.

**5. Check it**

Play one full round while signed in, then in the SQL Editor:

```sql
select status, rejection_reason, verified_score, claimed_score from public.runs order by submitted_at desc limit 5;
select run_id, slices_done, cursor_tick, last_error from public.verification_jobs;
```

A healthy run moves from `pending` to `verified` within about ten seconds, and its job row is deleted. If a job stays
with `last_error` set, that message is the diagnosis. If the run is rejected as `unsupported_version`, the deployed
bundle is older than the client: run step 3 again.

## How a run is verified

- The `runs_start_verification` trigger fires on `runs` INSERT. It enqueues a job, then posts `{ record: { id } }` to
  the function, which claims the job.
- Each invocation replays at most `SLICE_TICKS` (6,000) ticks, saves the state, and posts `{ job_id }` to itself. A full
  three-minute round is two slices.
- `reconcile_verification_jobs`, scheduled every minute by pg_cron, kicks the function when a job has been idle for over
  a minute. It also rejects jobs that used their whole slice budget, so a run is never pending forever. Because the
  trigger enqueues before it posts, a failed post is recovered here.

## Local development

```sh
supabase functions serve verify-run --no-verify-jwt
```

Requires Docker. Without it, `supabase functions deploy` still works (it builds server-side) but `serve` does not.
