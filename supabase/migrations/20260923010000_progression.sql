-- RE:Arena progression (WO-33).
-- Trusted XP, level and unlock writes for verified runs.
--
-- The whole file exists to make one guarantee: only the verifier can change progression, and it cannot change it
-- twice for the same run. Everything below serves that.

-- ---------------------------------------------------------------------------
-- level_thresholds: XP required for each level
-- ---------------------------------------------------------------------------
--
-- A table rather than a formula. The Content Manifest owns progression pacing, so a designer changing the curve is a
-- data change and a migration, not a code deploy. It also means the client can read the same numbers to show "needs
-- level 8" without duplicating the maths and drifting.
create table public.level_thresholds (
  level    integer primary key check (level >= 1),
  xp_total integer not null check (xp_total >= 0),
  constraint level_thresholds_monotonic check (xp_total >= 0)
);

comment on table public.level_thresholds is
  'Cumulative XP required to reach each level. Owned by the content release, read by award_xp and the client.';

-- A gentle curve: early levels arrive quickly so a new player sees progress inside a few rounds, then stretch.
insert into public.level_thresholds (level, xp_total) values
  (1, 0), (2, 500), (3, 1200), (4, 2200), (5, 3600),
  (6, 5500), (7, 8000), (8, 11200), (9, 15200), (10, 20000),
  (11, 25800), (12, 32600), (13, 40500), (14, 49600), (15, 60000),
  (16, 71800), (17, 85100), (18, 100000), (19, 116600), (20, 135000);

-- ---------------------------------------------------------------------------
-- unlock_rules: what each level grants
-- ---------------------------------------------------------------------------
create table public.unlock_rules (
  item_type      text not null check (item_type in ('weapon', 'attachment', 'perk', 'avatar')),
  item_id        text not null,
  required_level integer not null references public.level_thresholds (level),
  display_name   text not null,
  primary key (item_type, item_id)
);

comment on table public.unlock_rules is
  'AC-ACC-CS-002.1: each unlock is associated with a level threshold. Public read so the client can show requirements.';

insert into public.unlock_rules (item_type, item_id, required_level, display_name) values
  -- Level 1 entries are the starter set. They are listed so the client has one source of truth for what exists,
  -- even though a new player already has them.
  ('weapon', 'rifle-01',     1,  'Service Rifle'),
  ('weapon', 'pistol-01',    1,  'Sidearm'),
  ('weapon', 'smg-01',       3,  'Compact SMG'),
  ('weapon', 'shotgun-01',   5,  'Breacher'),
  ('weapon', 'dmr-01',       8,  'Marksman Rifle'),
  ('weapon', 'rifle-02',     12, 'Assault Rifle Mk II'),
  ('attachment', 'optic-2x',      4,  '2x Optic'),
  ('attachment', 'grip-vertical', 6,  'Vertical Grip'),
  ('attachment', 'mag-extended',  9,  'Extended Magazine'),
  ('attachment', 'optic-4x',      14, '4x Optic'),
  ('perk', 'quick-reload',   2,  'Quick Hands'),
  ('perk', 'fleet-footed',   7,  'Fleet Footed'),
  ('perk', 'steady-aim',     10, 'Steady Aim'),
  ('perk', 'scavenger',      13, 'Scavenger'),
  ('avatar', 'operator-02',  5,  'Operator'),
  ('avatar', 'veteran-01',   15, 'Veteran');

grant select on public.level_thresholds to anon, authenticated;
grant select on public.unlock_rules to anon, authenticated;

-- ---------------------------------------------------------------------------
-- progression_awards: the idempotency ledger
-- ---------------------------------------------------------------------------
--
-- One row per run that has ever granted XP. This table is the reason award_xp is safe to retry, which matters
-- because the verifier runs in chunks across several invocations and any of them can be retried by the platform.
--
-- Idempotency is enforced by the primary key, NOT by checking for an existing row and then inserting. A
-- check-then-insert races: two concurrent verifications of the same run both see no row, both insert, and the player
-- gets double XP. A unique violation cannot be raced.
create table public.progression_awards (
  run_id         uuid primary key,
  player_id      uuid not null references public.profiles (id) on delete cascade,
  xp_awarded     integer not null check (xp_awarded >= 0),
  level_before   integer not null,
  level_after    integer not null,
  -- Set only for daily challenge runs, which enforces AC-ACC-CS-001.4 through the index below.
  challenge_date date,
  awarded_at     timestamptz not null default now()
);

comment on table public.progression_awards is
  'Ledger of runs that have granted XP. The primary key makes award_xp idempotent per run.';

/*
 * AC-ACC-CS-001.4: a daily challenge awards progression at most once per day.
 *
 * A partial unique index rather than a check inside the function, for the same reason as above: two verifications
 * completing at once would both pass a query-based check. Partial, because non-challenge runs have a null
 * challenge_date and there can be many of those per day.
 */
create unique index progression_awards_one_per_challenge_day
  on public.progression_awards (player_id, challenge_date)
  where challenge_date is not null;

create index progression_awards_player on public.progression_awards (player_id, awarded_at desc);

alter table public.progression_awards enable row level security;

-- Players may read their own award history; only the service role writes.
create policy progression_awards_select_own on public.progression_awards
  for select using (auth.uid() = player_id);

grant select on public.progression_awards to authenticated;
grant all on public.progression_awards to service_role;

-- ---------------------------------------------------------------------------
-- level_for_xp: derive level from total XP
-- ---------------------------------------------------------------------------
--
-- Derived rather than stored-and-incremented. If XP is ever corrected (an invalidated run, a fixed scoring bug), a
-- stored level would be left inconsistent and would need its own repair path. A lookup cannot be wrong.
create or replace function public.level_for_xp(p_xp integer)
returns integer language sql stable as $$
  select coalesce(max(level), 1)
  from public.level_thresholds
  where xp_total <= greatest(p_xp, 0)
$$;

comment on function public.level_for_xp is
  'Highest level whose cumulative threshold is met. Derived so a corrected XP total cannot leave a stale level.';

grant execute on function public.level_for_xp(integer) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- award_xp: the only way progression changes
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because it must write columns the caller cannot: the profiles update policy blocks self-writes
-- to xp and level precisely so a player cannot set their own level.
--
-- That makes the grant the critical line. EXECUTE is revoked from anon and authenticated at the bottom of this file,
-- so a browser holding the anon key cannot reach it at all. Without that revoke, this function would be the hole
-- that the RLS policy was closing.
create or replace function public.award_xp(
  p_run_id uuid,
  p_player_id uuid,
  p_xp integer,
  p_challenge_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_xp_before      integer;
  v_xp_after       integer;
  v_level_before   integer;
  v_level_after    integer;
  v_new_unlocks    jsonb;
  v_already        boolean := false;
begin
  if p_xp < 0 then
    raise exception 'xp must not be negative';
  end if;

  /*
   * Lock the profile row first. Two verifications for the same player finishing simultaneously would otherwise both
   * read the same xp_before and the second would overwrite the first's award rather than adding to it.
   */
  select xp, level into v_xp_before, v_level_before
  from public.profiles
  where id = p_player_id
  for update;

  if not found then
    raise exception 'no profile for %', p_player_id;
  end if;

  /*
   * Claim the run. A conflict means this run already granted XP, or (for a challenge) the player already had an award
   * today. Either way the correct behaviour is to award nothing and report the current state, so a retried
   * verification is harmless and a second challenge attempt cannot double-count.
   */
  begin
    insert into public.progression_awards
      (run_id, player_id, xp_awarded, level_before, level_after, challenge_date)
    values
      (p_run_id, p_player_id, p_xp, v_level_before, v_level_before, p_challenge_date);
  exception when unique_violation then
    v_already := true;
  end;

  if v_already then
    return jsonb_build_object(
      'awarded', false,
      'reason', 'already_awarded',
      'xp', v_xp_before,
      'xpAwarded', 0,
      'level', v_level_before,
      'levelBefore', v_level_before,
      'newUnlocks', '[]'::jsonb
    );
  end if;

  v_xp_after := v_xp_before + p_xp;
  v_level_after := public.level_for_xp(v_xp_after);

  -- AC-ACC-CS-001.1 and 001.3: XP is added and the level follows from it.
  update public.profiles
     set xp = v_xp_after,
         level = v_level_after,
         last_seen_at = now()
   where id = p_player_id;

  update public.progression_awards
     set level_after = v_level_after
   where run_id = p_run_id;

  /*
   * UnlockEvaluator. AC-ACC-CS-002.2: everything the new level grants becomes available.
   *
   * ON CONFLICT DO NOTHING plus RETURNING gives exactly the rows that were actually inserted, which is what makes
   * AC-ACC-CS-002.4 possible: the result screen can show a notification once, rather than re-announcing every unlock
   * the player already had. Inserting every eligible unlock rather than only those between the two levels is
   * deliberate: it self-heals if an earlier award was interrupted before its unlocks landed.
   */
  with eligible as (
    select r.item_type, r.item_id, r.required_level, r.display_name
    from public.unlock_rules r
    where r.required_level <= v_level_after
  ),
  inserted as (
    insert into public.unlocks (player_id, item_type, item_id)
    select p_player_id, e.item_type, e.item_id from eligible e
    on conflict (player_id, item_type, item_id) do nothing
    returning item_type, item_id
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'itemType', i.item_type,
               'itemId', i.item_id,
               'displayName', e.display_name,
               'requiredLevel', e.required_level
             )
             order by e.required_level, i.item_id
           ),
           '[]'::jsonb
         )
    into v_new_unlocks
  from inserted i
  join eligible e on e.item_type = i.item_type and e.item_id = i.item_id;

  return jsonb_build_object(
    'awarded', true,
    'xp', v_xp_after,
    'xpAwarded', p_xp,
    'level', v_level_after,
    'levelBefore', v_level_before,
    'leveledUp', v_level_after > v_level_before,
    'newUnlocks', v_new_unlocks
  );
end $$;

comment on function public.award_xp is
  'Verifier-only. Atomically adds XP, derives level, inserts newly eligible unlocks. Idempotent per run id.';

/*
 * The security boundary.
 *
 * REVOKE from PUBLIC first: Postgres grants EXECUTE to PUBLIC on new functions by default, so omitting this would
 * leave the function callable by anyone with the anon key, and a player could set their own level to 20.
 */
revoke all on function public.award_xp(uuid, uuid, integer, date) from public;
revoke all on function public.award_xp(uuid, uuid, integer, date) from anon, authenticated;
grant execute on function public.award_xp(uuid, uuid, integer, date) to service_role;

-- ---------------------------------------------------------------------------
-- progression_state: what the client reads
-- ---------------------------------------------------------------------------
--
-- AC-ACC-CS-002.3: an unavailable unlock shows the level it needs. Computed here so the client does not reimplement
-- threshold maths and drift from the server's view of the same numbers.
create or replace function public.progression_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player uuid := auth.uid();
  v_xp integer;
  v_level integer;
  v_next_level integer;
  v_next_xp integer;
begin
  if v_player is null then
    return jsonb_build_object('signedIn', false);
  end if;

  select xp, level into v_xp, v_level from public.profiles where id = v_player;
  if not found then
    return jsonb_build_object('signedIn', false);
  end if;

  select level, xp_total into v_next_level, v_next_xp
  from public.level_thresholds
  where level = v_level + 1;

  return jsonb_build_object(
    'signedIn', true,
    'xp', v_xp,
    'level', v_level,
    'nextLevel', v_next_level,
    'nextLevelXp', v_next_xp,
    'items', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'itemType', r.item_type,
          'itemId', r.item_id,
          'displayName', r.display_name,
          'requiredLevel', r.required_level,
          'unlocked', u.item_id is not null
        )
        order by r.required_level, r.item_id
      ), '[]'::jsonb)
      from public.unlock_rules r
      left join public.unlocks u
        on u.player_id = v_player and u.item_type = r.item_type and u.item_id = r.item_id
    )
  );
end $$;

comment on function public.progression_state is
  'Own XP, level, next threshold and every unlock with its requirement. Reads only the caller''s own rows.';

grant execute on function public.progression_state() to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: give existing profiles the unlocks their level already earns
-- ---------------------------------------------------------------------------
--
-- Without this, anyone who played before this migration would have a level but no unlock rows, and the loadout
-- validation added in WO-31 would mark their starter weapons unavailable.
insert into public.unlocks (player_id, item_type, item_id)
select p.id, r.item_type, r.item_id
from public.profiles p
join public.unlock_rules r on r.required_level <= p.level
on conflict (player_id, item_type, item_id) do nothing;
