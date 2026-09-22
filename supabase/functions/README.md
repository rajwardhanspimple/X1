# Edge Functions

All server code for RE:Arena runs here, on the Supabase free plan (500k invocations/month, 2 s CPU and 150 s wall time per call).

| Function | Trigger | Work order |
| --- | --- | --- |
| `submit-run` | Client POST after a round | WO-53 |
| `verify-run` | Database Webhook on `verification_jobs` INSERT, then chained via `advance_verification` | WO-38 |
| `rotate-daily-challenge` | pg_cron 00:00 UTC | WO-44 |
| `admin-content-publish` | Operator or CI | WO-8 |
| `delete-account` | Client, authenticated | WO-28 |

## Secrets

Set with `supabase secrets set NAME=value` (never committed):

- `VERIFIER_WEBHOOK_SECRET`: shared with the Database Webhook header `x-verifier-secret` (stored in Vault)
- `CONTENT_BASE_URL`: the `rearena-content` static host, for SimContent
- `VERIFIER_SLICE_TICKS` (optional, default 6000)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## Local

```sh
supabase functions serve --env-file supabase/.env.local
```

## Deploy

```sh
supabase functions deploy verify-run --no-verify-jwt
```

CI deploys every function on tagged releases (WO-35).
