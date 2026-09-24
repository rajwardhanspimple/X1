-- RE:Arena leaderboard reads for the Leaderboard screen (WO-43).
--
-- leaderboard() gains accuracy, the run's simulation version and the board total, which the screen needs for its
-- columns, for ghost eligibility and for pagination. It is now SECURITY DEFINER and filters hidden and flagged players
-- itself, because it joins runs, which row-level security limits to the caller's own rows. The filter is the same one
-- the leaderboard_entries policy applies.
--
-- Accuracy comes from the run's claimed summary. The verifier rejects a claimed score above the replayed one; accuracy
-- is display only and cannot move a rank, which is score then achieved time.
--
-- my_rank() now returns the caller's whole row, so the screen can pin it under the page without a second query, and it
-- reports a hidden player as hidden rather than ranking them against a board they are not on.

drop function if exists public.leaderboard(text, text, text, integer, integer);

create function public.leaderboard(
  p_map_id text,
  p_mode_id text,
  p_period text default 'all-time',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  rank         bigint,
  player_id    uuid,
  display_name text,
  avatar_id    text,
  country      char(2),
  level        integer,
  score        integer,
  accuracy_bp  integer,
  achieved_at  timestamptz,
  run_id       uuid,
  sim_version  integer,
  has_ghost    boolean,
  total        bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select e.player_id, e.score, e.achieved_at, e.run_id
    from public.leaderboard_entries e
    join public.profiles p on p.id = e.player_id
    where e.map_id = p_map_id
      and e.mode_id = p_mode_id
      and e.period = p_period
      and e.period_start = public.period_start_for(p_period, now())
      and p.hidden_from_boards = false
      and p.flagged_at is null
  ),
  ranked as (
    select v.*,
           row_number() over (order by v.score desc, v.achieved_at) as rank,
           count(*) over () as total
    from visible v
  )
  select
    r.rank,
    r.player_id,
    p.display_name::text,
    p.avatar_id,
    p.country,
    p.level,
    r.score,
    case when ru.claimed_summary ? 'accuracyBp'
         then round((ru.claimed_summary->>'accuracyBp')::numeric)::integer end,
    r.achieved_at,
    r.run_id,
    ru.sim_version,
    g.id is not null,
    r.total
  from ranked r
  join public.profiles p on p.id = r.player_id
  join public.runs ru on ru.id = r.run_id
  left join public.ghosts g on g.run_id = r.run_id
  order by r.rank
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset)
$$;

comment on function public.leaderboard is
  'One ranked page with accuracy, sim version, ghost flag and board total. Hidden and flagged players excluded.';

grant execute on function public.leaderboard(text, text, text, integer, integer)
  to anon, authenticated, service_role;

create or replace function public.my_rank(
  p_map_id text,
  p_mode_id text,
  p_period text default 'all-time'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player uuid := auth.uid();
  v_start  date := public.period_start_for(p_period, now());
  v_entry  record;
  v_rank   bigint;
  v_total  bigint;
begin
  if v_player is null then
    return jsonb_build_object('ranked', false, 'reason', 'not_signed_in');
  end if;

  select e.score, e.achieved_at, e.run_id,
         p.display_name::text as display_name, p.hidden_from_boards, p.flagged_at,
         ru.sim_version, ru.claimed_summary->>'accuracyBp' as accuracy,
         exists (select 1 from public.ghosts g where g.run_id = e.run_id) as has_ghost
    into v_entry
    from public.leaderboard_entries e
    join public.profiles p on p.id = e.player_id
    join public.runs ru on ru.id = e.run_id
   where e.player_id = v_player
     and e.map_id = p_map_id
     and e.mode_id = p_mode_id
     and e.period = p_period
     and e.period_start = v_start;

  if not found then
    return jsonb_build_object('ranked', false, 'reason', 'no_entry');
  end if;

  if v_entry.hidden_from_boards or v_entry.flagged_at is not null then
    return jsonb_build_object('ranked', false, 'reason', 'hidden');
  end if;

  -- The tie-break matches leaderboard() exactly, or the pinned rank would disagree with the row in the list.
  select count(*) + 1 into v_rank
    from public.leaderboard_entries e
    join public.profiles p on p.id = e.player_id
   where e.map_id = p_map_id
     and e.mode_id = p_mode_id
     and e.period = p_period
     and e.period_start = v_start
     and p.hidden_from_boards = false
     and p.flagged_at is null
     and (e.score > v_entry.score
          or (e.score = v_entry.score and e.achieved_at < v_entry.achieved_at));

  select count(*) into v_total
    from public.leaderboard_entries e
    join public.profiles p on p.id = e.player_id
   where e.map_id = p_map_id
     and e.mode_id = p_mode_id
     and e.period = p_period
     and e.period_start = v_start
     and p.hidden_from_boards = false
     and p.flagged_at is null;

  return jsonb_build_object(
    'ranked', true,
    'rank', v_rank,
    'total', v_total,
    'score', v_entry.score,
    'achievedAt', v_entry.achieved_at,
    'playerId', v_player,
    'displayName', v_entry.display_name,
    'runId', v_entry.run_id,
    'simVersion', v_entry.sim_version,
    'accuracyBp', case when v_entry.accuracy is null then null
                       else round(v_entry.accuracy::numeric)::integer end,
    'hasGhost', v_entry.has_ghost
  );
end $$;

grant execute on function public.my_rank(text, text, text) to authenticated;
