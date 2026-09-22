# Supabase

Project reference (production): `nprfxnegcwqqpjasoxln`, free plan. No staging project.

```
migrations/   forward-only SQL, named YYYYMMDDHHMMSS_description.sql
functions/    Edge Functions: submit-run, verify-run (the verifier), rotate-daily-challenge,
              admin-content-publish, delete-account
seed/         local development seed data
```

Local development: `supabase start`, then `supabase db reset` to apply migrations and seed.

Secrets (database password, service role key, webhook secret) are never committed. Use `supabase link --project-ref nprfxnegcwqqpjasoxln` and the CLI's own credential storage; function secrets go through `supabase secrets set`.
