-- RE:Arena result commit and leaderboard reads (WO-53, WO-41).

-- ---------------------------------------------------------------------------
-- commit_verified_run: everything a verified run implies, atomically
-- ---------------------------------------------------------------------------
--
-- One transaction for the run status, the board entries, the ghost promotion and the XP award. A partial commit is the
-- worst outcome available here: a run on the leaderboard that granted no XP, or XP for a run that never reached the
-- board, with nothing recording which half succeeded.
--
-- Verifier-only, like award_xp. The score written here is the replayed one, never the client's claim.
create or replace function public.commit_verified_run(
  p_run_id uuid,
  p_verified_score integer,
  p_xp integer,
  p_promote_ghost boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run          public.runs;
  v_progression  jsonb;
  v_periods      text[] := array['all-time', 'weekly', 'daily'];
  v_period       text;
  v_period_start date;
  v_improved     boolean := false;
  v_boards       jsonb := '[]'::jsonb;
begin
  -- Lock the run so two verifier invocations cannot both commit it.
  select * into v_run from public.runs where id = p_run_id for update;
  if not found then
    raise exception 'no run %', p_run_id;
  end if;

  /*
   * Already settled. Returning the current state rather than raising makes the whole commit idempotent, which matters
   * because the verifier can be retried by the platform after a successful commit but before it recorded success.
   */
  if v_run.status <> 'pending' then
    return jsonb_build_object(
      'committed', false,
      'reason', 'already_' || v_run.status,
      'verifiedScore', v_run.verified_score
    );
  end if;

  update public.runs
     set status = 'verified',
         verified_score = p_verified_score,
         verified_at = now()
   where id = p_run_id;

  /*
   * Board entries, one per period.
   *
   * The conditional upsert is the important part: a later run that scored WORSE must not replace a player's best. A
   * blind upsert would silently demote them, and the bug would look like the leaderboard losing scores at random.
   */
  foreach v_period in array v_periods loop
    v_period_start := public.period_start_for(v_period, now());

    insert into public.leaderboard_entries
      (player_id, map_id, mode_id, period, period_start, score, run_id, achieved_at)
    values
      (v_run.player_id, v_run.map_id, v_run.mode_id, v_period, v_period_start,
       p_verified_score, p_run_id, now())
    on conflict (player_id, map_id, mode_id, period, period_start) do update
      set score = excluded.score,
          run_id = excluded.run_id,
          achieved_at = excluded.achieved_at
      where excluded.score > public.leaderboard_entries.score
    returning true into v_improved;

    v_boards := v_boards || jsonb_build_object(
      'period', v_period,
      'periodStart', v_period_start,
      'improved', coalesce(v_improved, false)
    );
    v_improved := false;
  end loop;

  /*
   * Ghost promotion. The decision is the verifier's, not this function's: whether a score is good enough to race
   * against depends on the current board, which the verifier has already read.
   */
  if p_promote_ghost then
    insert into public.ghosts
      (run_id, player_id, map_id, mode_id, score, log_path, log_bytes)
    values
      (p_run_id, v_run.player_id, v_run.map_id, v_run.mode_id, p_verified_score,
       v_run.log_path, v_run.log_bytes)
    on conflict (run_id) do nothing;
  end if;

  -- Last, so a failure here rolls back the board entries too rather than leaving them credited without XP.
  v_progression := public.award_xp(p_run_id, v_run.player_id, p_xp, v_run.challenge_date);

  return jsonb_build_object(
    'committed', true,
    'verifiedScore', p_verified_score,
    'boards', v_boards,
    'progression', v_progression
  );
end $$;

revoke all on function public.commit_verified_run(uuid, integer, integer, boolean) from public;
revoke all on function public.commit_verified_run(uuid, integer, integer, boolean) from anon, authenticated;
grant execute on function public.commit_verified_run(uuid, integer, integer, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- reject_run: record a failed verification
-- ---------------------------------------------------------------------------
--
-- AC-ACC-CS-001.2: a rejected run awards nothing. That is guaranteed by this function never calling award_xp, rather
-- than by award_xp checking a status it would have to read separately.
create or replace function public.reject_run(
  p_run_id uuid,
  p_reason text,
  p_first_mismatch_tick integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.runs
     set status = 'rejected',
         rejection_reason = p_reason,
         first_mismatch_tick = p_first_mismatch_tick
   where id = p_run_id
     and status = 'pending';

  if not found then
    return jsonb_build_object('rejected', false, 'reason', 'not_pending');
  end if;

  return jsonb_build_object('rejected', true, 'reason', p_reason);
end $$;

revoke all on function public.reject_run(uuid, text, integer) from public;
revoke all on function public.reject_run(uuid, text, integer) from anon, authenticated;
grant execute on function public.reject_run(uuid, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- leaderboard: a ranked page (WO-41)
-- ---------------------------------------------------------------------------
--
-- Rank is computed here with a window function, not in the client. Client-side ranking breaks as soon as the board is
-- paginated: page two has no way to know how many rows preceded it, so every row would be numbered from 1.
--
-- Hidden and flagged players are excluded by the RLS policy on leaderboard_entries rather than by a predicate in this
-- query. A predicate can be forgotten when someone writes the next query; a policy cannot be.
create or replace function public.leaderboard(
  p_map_id text,
  p_mode_id text,
  p_period text default 'all-time',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  rank          bigint,
  player_id     uuid,
  display_name  text,
  avatar_id     text,
  country       char(2),
  level         integer,
  score         integer,
  achieved_at   timestamptz,
  run_id        uuid,
  has_ghost     boolean
)
language sql
stable
as $$
  with ranked as (
    select
      -- Dense ordering by score then achieved_at: the same order as the covering index, so no sort is needed.
      row_number() over (order by e.score desc, e.achieved_at) as rank,
      e.player_id,
      e.score,
      e.achieved_at,
      e.run_id
    from public.leaderboard_entries e
    where e.map_id = p_map_id
      and e.mode_id = p_mode_id
      and e.period = p_period
      and e.period_start = public.period_start_for(p_period, now())
  )
  select
    r.rank,
    r.player_id,
    p.display_name::text,
    p.avatar_id,
    p.country,
    p.level,
    r.score,
    r.achieved_at,
    r.run_id,
    g.id is not null as has_ghost
  from ranked r
  join public.public_profiles p on p.id = r.player_id
  left join public.ghosts g on g.run_id = r.run_id
  order by r.rank
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset)
$$;

comment on function public.leaderboard is
  'One ranked page. Rank is computed server-side because a paginated client cannot know how many rows precede it.';

grant execute on function public.leaderboard(text, text, text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- my_rank: the caller's own standing
-- ---------------------------------------------------------------------------
--
-- Separate from the page query so the client can pin the player's own row without fetching every page until it finds
-- them. A player at rank 4,000 would otherwise need eighty requests to discover their position.
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
  v_score integer;
  v_achieved timestamptz;
  v_rank bigint;
  v_total bigint;
  v_start date := public.period_start_for(p_period, now());
begin
  if v_player is null then
    return jsonb_build_object('ranked', false, 'reason', 'not_signed_in');
  end if;

  select e.score, e.achieved_at into v_score, v_achieved
  from public.leaderboard_entries e
  where e.player_id = v_player
    and e.map_id = p_map_id
    and e.mode_id = p_mode_id
    and e.period = p_period
    and e.period_start = v_start;

  if not found then
    return jsonb_build_object('ranked', false, 'reason', 'no_entry');
  end if;

  /*
   * Count better entries rather than numbering the whole board and searching it. This is an index range scan whose
   * cost does not grow with the player's position, where row_number() over the full board would.
   *
   * The tie-break must match leaderboard() exactly or a player's pinned rank would disagree with the row they see in
   * the list, which looks like the board being broken.
   */
  select count(*) + 1 into v_rank
  from public.leaderboard_entries e
  where e.map_id = p_map_id
    and e.mode_id = p_mode_id
    and e.period = p_period
    and e.period_start = v_start
    and (e.score > v_score or (e.score = v_score and e.achieved_at < v_achieved));

  select count(*) into v_total
  from public.leaderboard_entries e
  where e.map_id = p_map_id
    and e.mode_id = p_mode_id
    and e.period = p_period
    and e.period_start = v_start;

  return jsonb_build_object(
    'ranked', true,
    'rank', v_rank,
    'total', v_total,
    'score', v_score,
    'achievedAt', v_achieved
  );
end $$;

grant execute on function public.my_rank(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- my_runs: recent attempts with their verification state
-- ---------------------------------------------------------------------------
--
-- Includes rejected runs and the reason. A player who knows they scored well and sees nothing on the board deserves an
-- explanation, and hiding rejections would make the verifier look like it lost the run.
create or replace function public.my_runs(p_limit integer default 20)
returns table (
  id               uuid,
  map_id           text,
  mode_id          text,
  claimed_score    integer,
  verified_score   integer,
  status           public.run_status,
  rejection_reason text,
  submitted_at     timestamptz,
  verified_at      timestamptz
)
language sql
stable
as $$
  select r.id, r.map_id, r.mode_id, r.claimed_score, r.verified_score,
         r.status, r.rejection_reason, r.submitted_at, r.verified_at
  from public.runs r
  where r.player_id = auth.uid()
  order by r.submitted_at desc
  limit greatest(1, least(p_limit, 100))
$$;

grant execute on function public.my_runs(integer) to authenticated;
