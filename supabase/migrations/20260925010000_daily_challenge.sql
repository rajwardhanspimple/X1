-- RE:Arena daily challenge lifecycle (WO-44).
-- One UTC configuration per day, one consumed attempt per player, and
-- verifier-owned result persistence. Forward-only migration.

-- ---------------------------------------------------------------------------
-- daily_challenges: one shared configuration per UTC day
-- ---------------------------------------------------------------------------
create table public.daily_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge_date date not null unique,
  map_id text not null check (map_id in ('container-yard-01', 'military-outpost-01', 'urban-street-01')),
  mode_id text not null check (mode_id = 'survival'),
  seed bigint not null,
  sim_version integer not null check (sim_version > 0),
  modifiers jsonb not null default '{}'::jsonb,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (opens_at = (challenge_date::timestamp at time zone 'UTC')),
  check (closes_at = ((challenge_date + 1)::timestamp at time zone 'UTC')),
  check (closes_at > opens_at)
);

comment on table public.daily_challenges is
  'The immutable shared configuration for one UTC challenge day.';

create index daily_challenges_open_window
  on public.daily_challenges (opens_at, closes_at);

-- ---------------------------------------------------------------------------
-- challenge_entries: the attempt is consumed before a round starts
-- ---------------------------------------------------------------------------
create table public.challenge_entries (
  challenge_id uuid not null references public.daily_challenges (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  attempt_started_at timestamptz not null default now(),
  score integer,
  created_at timestamptz not null default now(),
  primary key (challenge_id, player_id),
  unique (run_id)
);

comment on table public.challenge_entries is
  'One consumed attempt per player and challenge. A null score is a forfeited or pending attempt.';

create index challenge_entries_history
  on public.challenge_entries (player_id, challenge_id);

create index challenge_entries_board
  on public.challenge_entries (challenge_id, score desc nulls last, attempt_started_at);

-- Runs were originally keyed by challenge_date. Keep that contract and add the
-- canonical challenge foreign key for verifier/result joins.
alter table public.runs
  add column if not exists challenge_id uuid references public.daily_challenges (id) on delete set null;

create index runs_challenge on public.runs (challenge_id) where challenge_id is not null;

-- ---------------------------------------------------------------------------
-- UTC rotation
-- ---------------------------------------------------------------------------
create or replace function public.rotate_daily_challenge(
  p_challenge_date date default ((now() at time zone 'UTC')::date)
)
returns public.daily_challenges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.daily_challenges;
  v_day_number bigint := (p_challenge_date - date '1970-01-01');
  v_seed bigint;
  v_map text;
begin
  if p_challenge_date is null then
    raise exception 'challenge_date_required' using errcode = '22004';
  end if;

  -- SHA-256 makes the seed reproducible without depending on server randomness.
  v_seed := ('x' || substr(
    encode(digest(p_challenge_date::text || ':rearena-daily-challenge-v1', 'sha256'), 'hex'),
    1,
    16
  ))::bit(64)::bigint;

  v_map := case ((v_day_number % 3 + 3) % 3)
    when 0 then 'container-yard-01'
    when 1 then 'military-outpost-01'
    else 'urban-street-01'
  end;

  insert into public.daily_challenges (
    challenge_date,
    map_id,
    mode_id,
    seed,
    sim_version,
    modifiers,
    opens_at,
    closes_at
  )
  values (
    p_challenge_date,
    v_map,
    'survival',
    v_seed,
    8,
    '{}'::jsonb,
    p_challenge_date::timestamp at time zone 'UTC',
    (p_challenge_date + 1)::timestamp at time zone 'UTC'
  )
  on conflict (challenge_date) do nothing;

  select * into strict v_challenge
  from public.daily_challenges
  where challenge_date = p_challenge_date;

  return v_challenge;
end;
$$;

comment on function public.rotate_daily_challenge(date) is
  'Idempotently creates the shared configuration for one UTC day.';

revoke all on function public.rotate_daily_challenge(date) from public;
grant execute on function public.rotate_daily_challenge(date) to service_role;

-- pg_cron runs in UTC. Re-running the migration replaces the named job rather
-- than creating duplicate daily rotations.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'rearena-rotate-daily-challenge';

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'rearena-rotate-daily-challenge',
    '0 0 * * *',
    'select public.rotate_daily_challenge();'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public challenge descriptor and atomic attempt start
-- ---------------------------------------------------------------------------
create or replace function public.get_current_challenge()
returns table (
  challenge_id uuid,
  challenge_date date,
  map_id text,
  mode_id text,
  seed bigint,
  sim_version integer,
  modifiers jsonb,
  opens_at timestamptz,
  closes_at timestamptz,
  attempt_used boolean,
  attempt_started_at timestamptz,
  result_score integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.challenge_date,
    c.map_id,
    c.mode_id,
    c.seed,
    c.sim_version,
    c.modifiers,
    c.opens_at,
    c.closes_at,
    e.player_id is not null,
    e.attempt_started_at,
    e.score
  from public.daily_challenges c
  left join public.challenge_entries e
    on e.challenge_id = c.id
   and e.player_id = auth.uid()
  where c.challenge_date = (now() at time zone 'UTC')::date;
$$;

grant execute on function public.get_current_challenge() to anon, authenticated, service_role;

create or replace function public.start_challenge_attempt(p_challenge_id uuid)
returns table (
  challenge_id uuid,
  challenge_date date,
  map_id text,
  mode_id text,
  seed bigint,
  sim_version integer,
  modifiers jsonb,
  opens_at timestamptz,
  closes_at timestamptz,
  attempt_started_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid := auth.uid();
  v_challenge public.daily_challenges;
  v_started_at timestamptz := now();
begin
  if v_player_id is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;

  select * into v_challenge
  from public.daily_challenges
  where id = p_challenge_id
  for share;

  if not found then
    raise exception 'challenge_not_found' using errcode = 'P0002';
  end if;

  if v_started_at < v_challenge.opens_at or v_started_at >= v_challenge.closes_at then
    raise exception 'challenge_window_closed' using errcode = 'P0001';
  end if;

  insert into public.challenge_entries (challenge_id, player_id, attempt_started_at)
  values (v_challenge.id, v_player_id, v_started_at)
  on conflict (challenge_id, player_id) do nothing;

  if not found then
    raise exception 'challenge_attempt_already_used' using errcode = '23505';
  end if;

  return query select
    v_challenge.id,
    v_challenge.challenge_date,
    v_challenge.map_id,
    v_challenge.mode_id,
    v_challenge.seed,
    v_challenge.sim_version,
    v_challenge.modifiers,
    v_challenge.opens_at,
    v_challenge.closes_at,
    v_started_at;
end;
$$;

revoke all on function public.start_challenge_attempt(uuid) from public;
revoke all on function public.start_challenge_attempt(uuid) from anon;
grant execute on function public.start_challenge_attempt(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Challenge history, streak, and separate verified challenge board
-- ---------------------------------------------------------------------------
create or replace function public.get_challenge_history(p_limit integer default 30)
returns table (
  challenge_date date,
  challenge_id uuid,
  score integer,
  run_id uuid,
  current_streak integer
)
language sql
stable
security definer
set search_path = public
as $$
  with completed as (
    select c.challenge_date, c.id as challenge_id, e.score, e.run_id,
           c.challenge_date + (row_number() over (order by c.challenge_date desc))::integer as streak_key
    from public.challenge_entries e
    join public.daily_challenges c on c.id = e.challenge_id
    where e.player_id = auth.uid()
      and e.score is not null
    order by c.challenge_date desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
  ),
  latest as (
    select streak_key from completed order by challenge_date desc limit 1
  ),
  streak as (
    select count(*)::integer as value
    from completed c
    join latest l on l.streak_key = c.streak_key
  )
  select c.challenge_date, c.challenge_id, c.score, c.run_id, s.value
  from completed c cross join streak s
  order by c.challenge_date desc;
$$;

grant execute on function public.get_challenge_history(integer) to authenticated, service_role;

create or replace function public.get_challenge_leaderboard(
  p_challenge_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  rank bigint,
  player_id uuid,
  display_name text,
  avatar_id text,
  country char(2),
  score integer,
  achieved_at timestamptz,
  run_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select e.player_id, e.score, e.attempt_started_at as achieved_at, e.run_id
    from public.challenge_entries e
    join public.profiles p on p.id = e.player_id
    where e.challenge_id = p_challenge_id
      and e.score is not null
      and p.hidden_from_boards = false
      and p.flagged_at is null
  ), ranked as (
    select row_number() over (order by score desc, achieved_at asc) as rank, *
    from visible
  )
  select r.rank, r.player_id, p.display_name::text, p.avatar_id, p.country,
         r.score, r.achieved_at, r.run_id
  from ranked r
  join public.profiles p on p.id = r.player_id
  order by r.rank
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function public.get_challenge_leaderboard(uuid, integer, integer)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Result binding. The verifier remains the only writer of scores and XP.
-- ---------------------------------------------------------------------------
create or replace function public.bind_run_to_challenge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.challenge_date is not null then
    select id into new.challenge_id
    from public.daily_challenges
    where challenge_date = new.challenge_date;

    if new.challenge_id is null then
      raise exception 'challenge_not_found_for_date' using errcode = '23503';
    end if;
  else
    new.challenge_id := null;
  end if;

  return new;
end;
$$;

create or replace function public.sync_challenge_entry_from_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.challenge_id is not null then
    update public.challenge_entries
    set run_id = new.id,
        score = case when new.status = 'verified' then new.verified_score else score end
    where challenge_id = new.challenge_id
      and player_id = new.player_id
      and (run_id is null or run_id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists runs_bind_daily_challenge on public.runs;
create trigger runs_bind_daily_challenge
  before insert or update of challenge_date on public.runs
  for each row execute function public.bind_run_to_challenge();

drop trigger if exists runs_sync_challenge_entry on public.runs;
create trigger runs_sync_challenge_entry
  after insert or update of status, verified_score on public.runs
  for each row execute function public.sync_challenge_entry_from_run();

-- A challenge run must correspond to the attempt already consumed by the RPC.
drop policy if exists runs_insert_own on public.runs;
create policy runs_insert_own on public.runs
  for insert with check (
    auth.uid() = player_id
    and status = 'pending'
    and verified_score is null
    and verified_at is null
    and (
      challenge_date is null
      or exists (
        select 1
        from public.challenge_entries e
        join public.daily_challenges c on c.id = e.challenge_id
        where e.player_id = auth.uid()
          and c.challenge_date = runs.challenge_date
          and e.run_id is null
      )
    )
  );

-- Client reads are limited to a player's own attempt rows. Public board reads
-- use the security-definer board RPC above, which applies visibility filters.
alter table public.daily_challenges enable row level security;
alter table public.challenge_entries enable row level security;

create policy daily_challenges_select_public on public.daily_challenges
  for select using (true);

create policy challenge_entries_select_own on public.challenge_entries
  for select using (auth.uid() = player_id);

revoke all on table public.daily_challenges from public;
revoke all on table public.challenge_entries from public;
grant select on public.daily_challenges to anon, authenticated;
grant select on public.challenge_entries to authenticated;
grant all on public.daily_challenges to service_role;
grant all on public.challenge_entries to service_role;

revoke all on function public.bind_run_to_challenge() from public;
revoke all on function public.sync_challenge_entry_from_run() from public;
grant execute on function public.bind_run_to_challenge() to service_role;
grant execute on function public.sync_challenge_entry_from_run() to service_role;
