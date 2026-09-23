-- RE:Arena competitive schema (WO-53).
-- Runs, chunked verification jobs, leaderboards, ghosts.
--
-- Two constraints shape everything here, and both come from the free tier:
--
--  1. An Edge Function gets 2 seconds of CPU. A three-minute replay is 10,800 ticks and needs far more, so
--     verification runs in slices across several invocations. verification_jobs carries the cursor and the
--     serialised simulation state between them.
--  2. The database is capped at 500 MB and storage at 1 GB. A 300 KB run log in a column would exhaust the database
--     after about 1,600 runs. The same logs in the storage bucket reach roughly 3,000 and, more importantly, are not
--     read at all when serving a leaderboard.

-- ---------------------------------------------------------------------------
-- runs: one row per submitted attempt
-- ---------------------------------------------------------------------------
create table public.runs (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references public.profiles (id) on delete cascade,
  /*
   * The client's own id for this attempt. Unique per player, which is what makes submission idempotent: a retry from
   * the offline queue hits this constraint instead of creating a second run.
   */
  client_run_id   text not null,
  map_id          text not null,
  mode_id         text not null,
  seed            bigint not null,
  sim_version     integer not null,
  content_hash    text not null,
  client_version  text not null,
  /** Set for a daily challenge attempt, so award_xp can apply the once-per-day rule. */
  challenge_date  date,
  -- Claimed by the client, never trusted. The verified figure is verified_score below.
  claimed_score   integer not null,
  claimed_summary jsonb not null,
  status          public.run_status not null default 'pending',
  rejection_reason text,
  first_mismatch_tick integer,
  /** Authoritative score, written only by the verifier. Null until verified. */
  verified_score  integer,
  verified_at     timestamptz,
  /** Storage object path for the input log. The log itself never enters the database. */
  log_path        text not null,
  log_bytes       integer not null check (log_bytes > 0),
  submitted_at    timestamptz not null default now(),
  unique (player_id, client_run_id)
);

comment on table public.runs is
  'Submitted attempts. claimed_* comes from the client and is never trusted; verified_score is written by the verifier.';

-- Board queries filter on exactly this combination, so the index matches it rather than being a generic per-column set.
create index runs_leaderboard on public.runs (map_id, mode_id, status, verified_score desc);
create index runs_player on public.runs (player_id, submitted_at desc);
create index runs_pending on public.runs (status) where status = 'pending';

-- ---------------------------------------------------------------------------
-- verification_jobs: chunked replay state
-- ---------------------------------------------------------------------------
create table public.verification_jobs (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.runs (id) on delete cascade,
  /** Tick the next slice resumes from. */
  cursor_tick    integer not null default 0,
  /** Canonical SimState bytes from the previous slice. Null on the first. */
  state          bytea,
  /** Hash of that state, checked after restore so a serialisation defect is not read as a replay mismatch. */
  resume_hash    text,
  slices_done    integer not null default 0,
  /*
   * Guards against a job that never finishes, whether from a malformed log or a defect in the verifier. Without a
   * ceiling a broken job would consume Edge Function invocations until the monthly quota was gone.
   */
  max_slices     integer not null default 12,
  /*
   * Lease expiry. A claim sets this a short way ahead; an invocation that dies without releasing the job lets the
   * lease lapse so another can pick it up. A plain boolean lock would strand the job forever.
   */
  claimed_until  timestamptz,
  attempts       integer not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (run_id)
);

comment on table public.verification_jobs is
  'Resumable replay state. A job is claimed with a conditional update so two invocations cannot work the same slice.';

create index verification_jobs_claimable
  on public.verification_jobs (claimed_until nulls first, created_at);

create trigger verification_jobs_updated_at before update on public.verification_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- leaderboard_entries: one row per player per board per period
-- ---------------------------------------------------------------------------
--
-- A table rather than a view over runs. A board read is the hottest query in the game, and a view would scan every
-- run ever submitted to find each player's best. This holds only the current best and is replaced when beaten.
create table public.leaderboard_entries (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references public.profiles (id) on delete cascade,
  map_id       text not null,
  mode_id      text not null,
  /** 'all-time', 'weekly', 'daily'. Text rather than an enum so a new period needs no migration. */
  period       text not null check (period in ('all-time', 'weekly', 'daily')),
  /** First day of the period. The epoch date for all-time, so the unique constraint works uniformly. */
  period_start date not null,
  score        integer not null,
  run_id       uuid not null references public.runs (id) on delete cascade,
  /*
   * Tie-break. Two identical scores rank by who achieved it first, which is deterministic and does not shuffle when
   * the board is re-read.
   */
  achieved_at  timestamptz not null,
  unique (player_id, map_id, mode_id, period, period_start)
);

comment on table public.leaderboard_entries is
  'Current best verified score per player per board per period. Written only by the verifier.';

-- Matches the ranking query exactly, including the tie-break, so a board page needs no sort.
create index leaderboard_entries_rank
  on public.leaderboard_entries (map_id, mode_id, period, period_start, score desc, achieved_at);

-- ---------------------------------------------------------------------------
-- ghosts: promoted replays
-- ---------------------------------------------------------------------------
create table public.ghosts (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.runs (id) on delete cascade,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  map_id       text not null,
  mode_id      text not null,
  score        integer not null,
  /** Public storage path. Ghosts are meant to be downloaded by other players. */
  log_path     text not null,
  log_bytes    integer not null check (log_bytes > 0),
  promoted_at  timestamptz not null default now(),
  unique (run_id)
);

comment on table public.ghosts is
  'Replays promoted for others to race against. Only verified runs are ever promoted.';

create index ghosts_board on public.ghosts (map_id, mode_id, score desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.runs                enable row level security;
alter table public.verification_jobs   enable row level security;
alter table public.leaderboard_entries enable row level security;
alter table public.ghosts              enable row level security;

-- A player reads their own runs, whatever the status, so a rejection is visible with its reason.
create policy runs_select_own on public.runs
  for select using (auth.uid() = player_id);

/*
 * Insert is allowed for the owner, but note what the client CANNOT set: status, verified_score and verified_at have
 * defaults or stay null, and the with-check below pins status to 'pending'. A client that tries to submit a
 * pre-verified run is rejected by the policy rather than by application code.
 */
create policy runs_insert_own on public.runs
  for insert with check (
    auth.uid() = player_id
    and status = 'pending'
    and verified_score is null
    and verified_at is null
  );

-- No update or delete policy for players at all: a submitted run is immutable from the client's side.

/*
 * Leaderboards are public, but exclude hidden and flagged players. Done in the policy rather than in a query, so no
 * client-side filtering can leak a hidden player by forgetting a where clause.
 */
create policy leaderboard_entries_select_public on public.leaderboard_entries
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = leaderboard_entries.player_id
        and p.hidden_from_boards = false
        and p.flagged_at is null
    )
  );

create policy ghosts_select_public on public.ghosts
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = ghosts.player_id
        and p.hidden_from_boards = false
        and p.flagged_at is null
    )
  );

-- verification_jobs has no player-facing policy: it is verifier state and nothing else needs it.

grant select, insert on public.runs to authenticated;
grant select on public.leaderboard_entries to anon, authenticated;
grant select on public.ghosts to anon, authenticated;
grant all on public.runs to service_role;
grant all on public.verification_jobs to service_role;
grant all on public.leaderboard_entries to service_role;
grant all on public.ghosts to service_role;

-- ---------------------------------------------------------------------------
-- period_start_for: which period a timestamp belongs to
-- ---------------------------------------------------------------------------
--
-- One definition, used by the verifier when writing an entry and by the board query when reading. Two definitions
-- would eventually disagree about which week a run near midnight belongs to, and the entry would be written to a
-- board nobody reads.
create or replace function public.period_start_for(p_period text, p_at timestamptz)
returns date language sql immutable as $$
  select case p_period
    -- A fixed sentinel rather than null, so the unique constraint treats all-time uniformly.
    when 'all-time' then date '1970-01-01'
    when 'weekly'   then (date_trunc('week', p_at at time zone 'UTC'))::date
    when 'daily'    then (p_at at time zone 'UTC')::date
  end
$$;

grant execute on function public.period_start_for(text, timestamptz) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- enqueue_verification: create the job for a submitted run
-- ---------------------------------------------------------------------------
--
-- Called by the submit-run function after the log is stored. Separate from the insert so a submission that fails
-- midway leaves a run with no job rather than a job pointing at no log.
create or replace function public.enqueue_verification(p_run_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  insert into public.verification_jobs (run_id)
  values (p_run_id)
  on conflict (run_id) do update set updated_at = now()
  returning id into v_job_id;
  return v_job_id;
end $$;

revoke all on function public.enqueue_verification(uuid) from public;
revoke all on function public.enqueue_verification(uuid) from anon, authenticated;
grant execute on function public.enqueue_verification(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- claim_verification_job: take the next job atomically
-- ---------------------------------------------------------------------------
--
-- A single conditional UPDATE ... RETURNING rather than select-then-update. Two Edge Function invocations racing on a
-- select would both see the same unclaimed job and both replay it, doubling CPU use and racing to commit the result.
-- An update with the lease condition in its WHERE clause can only succeed once.
create or replace function public.claim_verification_job(p_lease_seconds integer default 30)
returns table (
  job_id uuid,
  run_id uuid,
  cursor_tick integer,
  state bytea,
  resume_hash text,
  slices_done integer,
  max_slices integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.verification_jobs j
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1
   where j.id = (
     select c.id
     from public.verification_jobs c
     join public.runs r on r.id = c.run_id
     where (c.claimed_until is null or c.claimed_until < now())
       and c.slices_done < c.max_slices
       and r.status = 'pending'
     order by c.created_at
     limit 1
     -- Skips rows another transaction holds rather than waiting on them, so concurrent claims do not serialise.
     for update of c skip locked
   )
  returning j.id, j.run_id, j.cursor_tick, j.state, j.resume_hash, j.slices_done, j.max_slices;
end $$;

revoke all on function public.claim_verification_job(integer) from public;
revoke all on function public.claim_verification_job(integer) from anon, authenticated;
grant execute on function public.claim_verification_job(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------
--
-- runs is private: a log is the complete input sequence of a run, and reading another player's would reveal exactly
-- how they played. ghosts is public, because being raced against is the point of one.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('runs', 'runs', false, 5242880, array['application/gzip', 'application/octet-stream']),
  ('ghosts', 'ghosts', true, 5242880, array['application/gzip', 'application/octet-stream'])
on conflict (id) do nothing;

-- A player may write and read only their own prefix. The path convention is <player_id>/<client_run_id>.json.gz.
create policy runs_insert_own_object on storage.objects
  for insert to authenticated
  with check (bucket_id = 'runs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy runs_select_own_object on storage.objects
  for select to authenticated
  using (bucket_id = 'runs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy ghosts_select_public_object on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'ghosts');
