# Supabase

Project reference (production): `nprfxnegcwqqpjasoxln`. A separate staging project is created in Phase 4 (WO-14).

```
migrations/   forward-only SQL, named YYYYMMDDHHMMSS_description.sql
functions/    Edge Functions: submit-run, rotate-daily-challenge, admin-content-publish, delete-account
seed/         local development seed data
```

Local development: `supabase start`, then `supabase db reset` to apply migrations and seed.

Secrets (database password, service role key) are never committed. Use `supabase link --project-ref nprfxnegcwqqpjasoxln` and the CLI's own credential storage.
