-- WO-34: versioned weekly and seasonal boards with read-only archives.

alter table public.leaderboard_entries add column if not exists sim_version integer;
update public.leaderboard_entries e
set sim_version = r.sim_version
from public.runs r
where r.id = e.run_id and e.sim_version is null;

create or replace function public.set_leaderboard_sim_version()
returns trigger language plpgsql as $$
begin
  if new.sim_version is null then
    select sim_version into new.sim_version from public.runs where id = new.run_id;
  end if;
  return new;
end $$;

drop trigger if exists leaderboard_entries_sim_version on public.leaderboard_entries;
create trigger leaderboard_entries_sim_version
before insert or update on public.leaderboard_entries
for each row execute function public.set_leaderboard_sim_version();

alter table public.leaderboard_entries drop constraint if exists leaderboard_entries_player_id_map_id_mode_id_period_period_start_key;
alter table public.leaderboard_entries add constraint leaderboard_entries_board_key
  unique (player_id, map_id, mode_id, period, period_start, sim_version);
create index if not exists leaderboard_entries_board_lookup
  on public.leaderboard_entries (map_id, mode_id, period, period_start, sim_version, score desc, achieved_at);

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create unique index if not exists seasons_active_one on public.seasons ((ends_at > now())) where ends_at > now();
insert into public.seasons (name, starts_at, ends_at)
select 'Season 1', date_trunc('month', now()), date_trunc('month', now()) + interval '3 months'
where not exists (select 1 from public.seasons);

create table if not exists public.board_archives (
  id uuid primary key default gen_random_uuid(),
  map_id text not null,
  mode_id text not null,
  period text not null,
  period_start date not null,
  period_end date not null,
  sim_version integer not null,
  entries jsonb not null default '[]'::jsonb,
  archived_at timestamptz not null default now(),
  unique (map_id, mode_id, period, period_start, sim_version)
);

create or replace function public.current_season()
returns public.seasons language sql stable security definer set search_path = public as $$
  select * from public.seasons where starts_at <= now() and ends_at > now()
  order by starts_at desc limit 1
$$;

create or replace function public.season_period_start(p_season_id uuid)
returns date language sql stable security definer set search_path = public as $$
  select (starts_at at time zone 'UTC')::date from public.seasons where id = p_season_id
$$;

create or replace function public.archive_closed_boards()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  for r in select distinct e.map_id, e.mode_id, e.period, e.period_start, e.sim_version
    from public.leaderboard_entries e
    where (e.period = 'weekly' and e.period_start < public.period_start_for('weekly', now()))
       or (e.period = 'seasonal' and not exists (select 1 from public.seasons s where s.starts_at <= now() and s.ends_at > now()))
  loop
    insert into public.board_archives(map_id, mode_id, period, period_start, period_end, sim_version, entries)
    select r.map_id, r.mode_id, r.period, r.period_start,
      case when r.period = 'weekly' then r.period_start + 6 else r.period_start end,
      r.sim_version,
      coalesce(jsonb_agg(jsonb_build_object(
        'playerId', e.player_id, 'displayName', p.display_name, 'score', e.score,
        'achievedAt', e.achieved_at, 'runId', e.run_id, 'simVersion', e.sim_version,
        'accuracyBp', case when ru.claimed_summary ? 'accuracyBp' then round((ru.claimed_summary->>'accuracyBp')::numeric)::integer end,
        'hasGhost', exists(select 1 from public.ghosts g where g.run_id = e.run_id)
      ) order by e.score desc, e.achieved_at), '[]'::jsonb)
    from public.leaderboard_entries e join public.profiles p on p.id=e.player_id join public.runs ru on ru.id=e.run_id
    where e.map_id=r.map_id and e.mode_id=r.mode_id and e.period=r.period and e.period_start=r.period_start and e.sim_version=r.sim_version
    on conflict (map_id, mode_id, period, period_start, sim_version) do nothing;
    get diagnostics n = n + row_count;
  end loop;
  return n;
end $$;

-- Keep the existing five-argument callers valid. Null selects the newest version.
drop function if exists public.leaderboard(text, text, text, integer, integer);
create or replace function public.leaderboard(p_map_id text, p_mode_id text, p_period text default 'all-time', p_limit integer default 50, p_offset integer default 0)
returns table(rank bigint, player_id uuid, display_name text, avatar_id text, country char(2), level integer, score integer, accuracy_bp integer, achieved_at timestamptz, run_id uuid, sim_version integer, has_ghost boolean, total bigint)
language sql stable security definer set search_path=public as $$
with versioned as (select coalesce(max(sim_version), 0) v from public.leaderboard_entries where map_id=p_map_id and mode_id=p_mode_id and period=p_period), visible as (
 select e.*, count(*) over() total, row_number() over(order by e.score desc,e.achieved_at) rank
 from public.leaderboard_entries e join public.profiles p on p.id=e.player_id cross join versioned v
 where e.map_id=p_map_id and e.mode_id=p_mode_id and e.period=p_period and e.period_start=public.period_start_for(p_period,now()) and e.sim_version=v.v and p.hidden_from_boards=false and p.flagged_at is null)
select x.rank,x.player_id,p.display_name::text,p.avatar_id,p.country,p.level,x.score,
 case when r.claimed_summary ? 'accuracyBp' then round((r.claimed_summary->>'accuracyBp')::numeric)::integer end,
 x.achieved_at,x.run_id,x.sim_version,exists(select 1 from public.ghosts g where g.run_id=x.run_id),x.total
from visible x join public.profiles p on p.id=x.player_id join public.runs r on r.id=x.run_id order by x.rank limit greatest(1,least(p_limit,100)) offset greatest(0,p_offset)
$$;

grant execute on function public.leaderboard(text,text,text,integer,integer) to anon, authenticated, service_role;

create or replace function public.list_archived_periods(p_map_id text, p_mode_id text)
returns table(period text, period_start date, period_end date, sim_version integer, entry_count bigint)
language sql stable security definer set search_path=public as $$
select period,period_start,period_end,sim_version,jsonb_array_length(entries)::bigint from public.board_archives where map_id=p_map_id and mode_id=p_mode_id order by period_start desc,sim_version desc
$$;
create or replace function public.archived_leaderboard(p_map_id text,p_mode_id text,p_period text,p_period_start date,p_sim_version integer,p_limit integer default 50,p_offset integer default 0)
returns table(rank bigint,player_id uuid,display_name text,score integer,accuracy_bp integer,achieved_at timestamptz,run_id uuid,sim_version integer,has_ghost boolean,total bigint)
language sql stable security definer set search_path=public as $$
with rows as (select jsonb_array_elements(a.entries) v from public.board_archives a where a.map_id=p_map_id and a.mode_id=p_mode_id and a.period=p_period and a.period_start=p_period_start and a.sim_version=p_sim_version), ranked as (select row_number() over(order by (v->>'score')::int desc,(v->>'achievedAt')::timestamptz) rank,count(*) over() total,v from rows)
select rank,(v->>'playerId')::uuid,v->>'displayName',(v->>'score')::int,(v->>'accuracyBp')::int,(v->>'achievedAt')::timestamptz,(v->>'runId')::uuid,(v->>'simVersion')::int,coalesce((v->>'hasGhost')::boolean,false),total from ranked order by rank limit greatest(1,least(p_limit,100)) offset greatest(0,p_offset)
$$;
grant execute on function public.list_archived_periods(text,text), public.archived_leaderboard(text,text,text,date,integer,integer,integer) to anon,authenticated,service_role;

-- Idempotent close-of-period snapshot. pg_cron is available on Supabase free tier.
do $$ begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    if not exists (select 1 from cron.job where jobname='rearena-archive-boards') then
      perform cron.schedule('rearena-archive-boards','5 * * * *','select public.archive_closed_boards()');
    end if;
  end if;
exception when undefined_table then null;
end $$;
