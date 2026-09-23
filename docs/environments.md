# Environments

Everything runs on free tiers with no payment method on file, across two vendors: Supabase and Cloudflare. This document lists where each piece lives, the variables it needs, and the ceiling that would force a paid step.

## Hosting

| Piece               | Host                                                                   | Free tier                                                                                             | First ceiling                                     |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Game client         | Cloudflare Workers Static Assets (`rearena`)                           | Unmetered static requests and bandwidth; preview URL per PR                                           | None expected                                     |
| Content bundles     | Cloudflare Workers Static Assets (`rearena-content`)                   | Unmetered bandwidth; 25 MB per file; 20,000 files per deploy                                          | File count after many releases (pruned to last 5) |
| Backend             | Supabase project `nprfxnegcwqqpjasoxln`                                | 500 MB database, 1 GB storage, 5 GB egress, 500k Edge Function calls/month, 2 s CPU per call, 50k MAU | Database size; project pauses after 7 idle days   |
| Run logs and ghosts | Supabase Storage (`runs`, `ghosts`)                                    | Part of the 1 GB above                                                                                | About 20,000 logs at 50 KB                        |
| Verifier            | Supabase Edge Function `verify-run`, chunked replay (~4 calls per run) | Part of the 500k calls above                                                                          | Over 100,000 verified runs per month              |
| CI and deploys      | GitHub Actions                                                         | Unlimited minutes on public repos                                                                     | None                                              |

Environments: **local** (Supabase CLI, `pnpm dev`) and **production**. There is no staging project. Pull-request previews build against production with RLS as the guard.

## Variables (public, safe in the client bundle)

| Name                     | Where                            | Purpose                                               |
| ------------------------ | -------------------------------- | ----------------------------------------------------- |
| `VITE_SUPABASE_URL`      | client, GitHub Actions variables | Supabase project URL                                  |
| `VITE_SUPABASE_ANON_KEY` | client, GitHub Actions variables | Anonymous key (RLS-protected)                         |
| `VITE_CONTENT_BASE_URL`  | client, GitHub Actions variables | `rearena-content` static host base URL                |
| `VITE_BUILD_ID`          | client                           | Build identifier shown in settings and sent with runs |

## Secrets (never in git, never in the client)

| Name                                            | Where                                                          | Purpose                                               |
| ----------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`                     | Injected into Edge Functions; GitHub Actions (content publish) | Full database and storage access                      |
| `VERIFIER_WEBHOOK_SECRET`                       | Edge Function secret, Supabase Vault                           | Authenticates the Database Webhook and slice chaining |
| `CONTENT_BASE_URL`                              | Edge Function secret                                           | Content host for SimContent                           |
| `SUPABASE_ACCESS_TOKEN`                         | GitHub Actions                                                 | `supabase db push`, `functions deploy`, `secrets set` |
| `SUPABASE_DB_PASSWORD`                          | GitHub Actions                                                 | Migration pushes                                      |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions                                                 | `wrangler deploy` for client and content              |
| `SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `_SECRET`    | Supabase dashboard, local `.env`                               | Google OAuth                                          |
| `SUPABASE_AUTH_DISCORD_CLIENT_ID` / `_SECRET`   | Supabase dashboard, local `.env`                               | Discord OAuth                                         |

If a secret is ever pasted into a chat, ticket, or commit, rotate it immediately in the owning dashboard.

## Local setup

```sh
supabase start
supabase db reset      # applies migrations and seed
cp apps/client/.env.example apps/client/.env.local
# paste the local anon key printed by `supabase status` into VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
pnpm dev
```

## Linking production

```sh
supabase link --project-ref nprfxnegcwqqpjasoxln
supabase db push
```

Then in the Supabase dashboard: enable Anonymous sign-in (Authentication > Providers), and after WO-53 create the Database Webhook on `verification_jobs` INSERT pointing at the `verify-run` function with header `x-verifier-secret`.

## Keep-alive

Free Supabase projects pause after 7 days without API traffic. Until players provide that traffic, a GitHub Actions cron (added in WO-35) calls a public RPC once a day.
