# Environments

| Environment | Client | Backend | Notes |
| --- | --- | --- | --- |
| Local | `pnpm dev` on 127.0.0.1:5173 | Supabase CLI (`supabase start`) | Seeded fake players; fake clock for daily challenge |
| Preview | Vercel preview per pull request | Staging Supabase project | Playwright smoke runs against it |
| Staging | Vercel from `main` | Staging Supabase project | Verifier deployed from `main` |
| Production | Vercel from tag `vX.Y.Z` | Supabase project `nprfxnegcwqqpjasoxln` | Assets immutable by hash |

## Variables (public, safe in the client bundle)

| Name | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | client | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | client | Anonymous key (RLS-protected) |
| `VITE_CONTENT_BASE_URL` | client | Public content bucket base |
| `VITE_BUILD_ID` | client | Build identifier shown in settings and sent with runs |

## Secrets (never in git, never in the client)

| Name | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | verifier, GitHub Actions (content publish) | Full database and storage access |
| `DATABASE_URL` | verifier | Direct Postgres connection through the pooler |
| `SUPABASE_ACCESS_TOKEN` | GitHub Actions | `supabase db push` and `functions deploy` |
| `SUPABASE_DB_PASSWORD` | GitHub Actions | Migration pushes |
| `SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `_SECRET` | Supabase dashboard, local `.env` | Google OAuth |
| `SUPABASE_AUTH_DISCORD_CLIENT_ID` / `_SECRET` | Supabase dashboard, local `.env` | Discord OAuth |

If a secret is ever pasted into a chat, ticket, or commit, rotate it immediately in the Supabase dashboard (Project Settings > Database, or Project Settings > API).

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
