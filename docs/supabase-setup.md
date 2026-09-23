# Supabase setup

A single ordered path from nothing to a working backend. The order matters: anonymous sign-in must be enabled
before a guest session can be created, and the migration must be applied before a profile row can exist for
that session. Doing these out of order produces errors that do not name their cause.

Project reference: `nprfxnegcwqqpjasoxln`. Free plan, no staging project.

---

## 0. Rotate the database password

**Do this first.** The database password was pasted into a chat during planning, which means it must be treated
as public regardless of who saw it.

Supabase dashboard > Project Settings > Database > Reset database password.

A database password grants direct SQL access, bypassing every row-level security policy. Rotating it is not a
precaution, it is a repair.

---

## 1. Install the CLI

```sh
npm install -g supabase
supabase --version
```

On Windows, `npm install -g` is the reliable route. The Scoop and Chocolatey packages exist but lag behind.

---

## 2. Log in and link

```sh
supabase login
supabase link --project-ref nprfxnegcwqqpjasoxln
```

`login` opens a browser and stores an access token in the CLI's own credential store, not in the repository.
`link` writes `supabase/.temp/project-ref`, which is gitignored.

Linking prompts for the database password from step 0. If you skipped the rotation, do it now and use the new
one.

---

## 3. Apply the schema

```sh
supabase db push
```

This applies `supabase/migrations/20260922000001_baseline.sql`, which creates:

| Object | Purpose |
| --- | --- |
| `profiles` | One row per auth user: display name, avatar, XP, level, guest flag |
| `public_profiles` (view) | The columns other players may read, excluding flagged accounts |
| `player_settings` | One JSONB blob per player, versioned for last-write-wins sync |
| `loadouts` | Three slots per player |
| `unlocks` | Items earned, written only by `award_xp` |
| `on_auth_user_created` | Trigger that provisions a profile and settings row for every new user |
| `on_auth_user_updated` | Trigger that clears `is_guest` when a guest links a real identity |
| RLS policies | Owner-only on every table; progression columns are not self-writable |

Expect output listing the migration and `Finished supabase db push`. If it reports the migration is already
applied, the schema is in place and there is nothing to do.

### Why progression columns are protected

The `profiles_update_own` policy lets a player edit their own row but re-reads `xp`, `level` and `flagged_at`
from the table and requires the new values to equal the old ones. Without that, the anon key plus a REST call
would be enough to set your own level to 100, because RLS grants row access rather than column access.

---

## 4. Enable anonymous sign-in

Dashboard > Authentication > Providers > **Anonymous sign-ins** > enable.

This is what makes "play without an account" possible: the client calls `signInAnonymously()`, gets a real user
row with `is_anonymous = true`, and the trigger from step 3 provisions a profile. Progress is therefore saved
from the first round, before any decision about signing up.

`supabase/config.toml` already sets `enable_anonymous_sign_ins = true`, but that file governs the **local**
stack only. Hosted project settings are not read from it, which is why this step is manual.

---

## 5. Copy the project credentials

Dashboard > Project Settings > API. Take the **Project URL** and the **anon public** key.

```sh
cp apps/client/.env.example apps/client/.env.local
```

Fill in:

```
VITE_SUPABASE_URL=https://nprfxnegcwqqpjasoxln.supabase.co
VITE_SUPABASE_ANON_KEY=<the anon public key>
```

Leave `VITE_CONTENT_BASE_URL` empty; the client falls back to the built-in greybox arena.

**Take the anon key, not the service role key.** They sit next to each other, look alike, and both work during
testing. The service role key bypasses row-level security entirely, so shipping it in a browser bundle hands
every player full read and write access to the database.

---

## 6. Verify

```sh
node tools/check-env.mjs
```

This reads `.env.local` and reports what is set, what is missing, and whether the link succeeded. It decodes the
JWT to confirm the key carries the `anon` role, which is the one mistake from step 5 that is otherwise invisible
until something goes badly wrong.

A clean run prints `Environment looks good.`

---

## 7. Confirm the trigger works

Dashboard > SQL Editor:

```sql
select count(*) from public.profiles;
```

Zero is correct before anyone signs in. After the client creates its first guest session, the count becomes one
and the row carries a generated display name such as `SwiftFox4821` with `is_guest = true`. That confirms the
provisioning trigger fired, which is the single most important thing to verify: if it has not, a signed-in user
exists with no profile and every query returns empty for reasons that are hard to trace.

---

## Later, not now

| Task | Needed for |
| --- | --- |
| OAuth providers (Google, Discord) | WO-27 account upgrade. Guest play does not need them. |
| `supabase functions deploy verify-run` | WO-53, when runs are submitted |
| Database Webhook on `verification_jobs` INSERT | WO-53 |
| `supabase secrets set VERIFIER_WEBHOOK_SECRET=...` | WO-53 |
| GitHub Actions variables and secrets | First deploy |
| Keep-alive cron | WO-35. Free projects pause after 7 idle days. |

---

## Free plan limits worth knowing

| Limit | Value | What hits it first |
| --- | --- | --- |
| Database | 500 MB | Run logs, which is why they live in Storage instead |
| Storage | 1 GB | About 20,000 run logs at 50 KB |
| Egress | 5 GB/month | Ghost replay downloads |
| Edge Function calls | 500k/month | Verification, roughly 4 calls per run |
| Edge Function CPU | 2 s per call | Why the verifier replays in chunks rather than in one pass |
| Monthly active users | 50,000 | Guest sessions count toward this |
| Idle pause | 7 days without API traffic | Addressed by the WO-35 cron |
