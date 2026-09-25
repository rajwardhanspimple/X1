-- WO-28: profile identity, public projections, privacy, reports, and deletion support.

create table if not exists public.profanity_terms (
  term text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.profile_avatars (
  avatar_id text primary key
);

insert into public.profile_avatars (avatar_id) values
  ('default'), ('avatar_01'), ('avatar_02'), ('avatar_03'), ('avatar_04'), ('avatar_05'), ('avatar_06'), ('avatar_07')
on conflict do nothing;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_player_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(trim(reason)) between 3 and 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint reports_not_self check (reporter_id <> target_player_id)
);

create index if not exists reports_reporter_created on public.reports (reporter_id, created_at desc);
create index if not exists reports_target_created on public.reports (target_player_id, created_at desc);

alter table public.profanity_terms enable row level security;
alter table public.profile_avatars enable row level security;
alter table public.reports enable row level security;

create policy profile_avatars_read_public on public.profile_avatars for select to anon, authenticated using (true);
create policy reports_insert_own on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy reports_select_own on public.reports for select to authenticated using (reporter_id = auth.uid());

grant select on public.profile_avatars to anon, authenticated;
grant insert, select on public.reports to authenticated;
grant all on public.profanity_terms, public.reports to service_role;

create or replace function public.update_profile(
  p_display_name text default null,
  p_avatar_id text default null,
  p_country text default null,
  p_clear_country boolean default false,
  p_hidden_from_boards boolean default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := auth.uid();
  v_name text;
  v_avatar text;
  v_country char(2);
  v_profile public.profiles;
  v_term text;
begin
  if v_player is null then raise exception using errcode = '42501', message = 'not_authenticated'; end if;
  select * into v_profile from public.profiles where id = v_player for update;
  if not found then raise exception 'profile_not_found'; end if;

  if p_display_name is not null then
    v_name := btrim(p_display_name);
    if char_length(v_name) < 3 or char_length(v_name) > 16 then
      raise exception using errcode = '22023', message = 'display_name_length';
    end if;
    if v_name !~ '^[A-Za-z0-9_]+$' then
      raise exception using errcode = '22023', message = 'display_name_characters';
    end if;
    if v_name::citext <> v_profile.display_name and v_profile.display_name_changed_at is not null
       and v_profile.display_name_changed_at > now() - interval '30 days' then
      raise exception using errcode = '22023', message = 'display_name_cooldown';
    end if;
    if exists (select 1 from public.profiles where display_name = v_name::citext and id <> v_player) then
      raise exception using errcode = '23505', message = 'display_name_taken';
    end if;
    select term into v_term from public.profanity_terms
      where lower(v_name) like '%' || lower(term) || '%' limit 1;
    if v_term is not null then
      raise exception using errcode = '22023', message = 'display_name_profanity';
    end if;
  else
    v_name := v_profile.display_name::text;
  end if;

  if p_avatar_id is not null then
    if not exists (select 1 from public.profile_avatars where avatar_id = p_avatar_id) then
      raise exception using errcode = '22023', message = 'avatar_not_allowed';
    end if;
    v_avatar := p_avatar_id;
  else
    v_avatar := v_profile.avatar_id;
  end if;

  if p_clear_country then
    v_country := null;
  elsif p_country is not null then
    if upper(p_country) !~ '^[A-Z]{2}$' then
      raise exception using errcode = '22023', message = 'country_invalid';
    end if;
    v_country := upper(p_country)::char(2);
  else
    v_country := v_profile.country;
  end if;

  update public.profiles set
    display_name = v_name::citext,
    display_name_changed_at = case when v_name::citext <> v_profile.display_name then now() else display_name_changed_at end,
    avatar_id = v_avatar,
    country = v_country,
    hidden_from_boards = coalesce(p_hidden_from_boards, hidden_from_boards)
  where id = v_player
  returning * into v_profile;

  return jsonb_build_object('updated', true, 'displayName', v_profile.display_name::text,
    'avatarId', v_profile.avatar_id, 'country', v_profile.country,
    'hiddenFromBoards', v_profile.hidden_from_boards,
    'displayNameChangedAt', v_profile.display_name_changed_at);
exception when unique_violation then
  raise exception using errcode = '23505', message = 'display_name_taken';
end $$;

create or replace function public.get_profile(p_player_id uuid default auth.uid())
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'playerId', p.id,
    'displayName', p.display_name::text,
    'avatarId', p.avatar_id,
    'country', p.country,
    'level', p.level,
    'hiddenFromBoards', p.hidden_from_boards,
    'bestScores', coalesce((select jsonb_agg(x order by x->>'mapId') from (
      select jsonb_build_object('mapId', e.map_id, 'modeId', e.mode_id, 'score', e.score) x
      from public.leaderboard_entries e where e.player_id = p.id and e.period = 'all-time'
    ) s), '[]'::jsonb),
    'medalCount', coalesce((select sum(jsonb_array_length(coalesce(r.claimed_summary->'medals', '[]'::jsonb)))
      from public.runs r where r.player_id = p.id and r.status = 'verified'), 0)
  ) from public.profiles p
  where p.id = p_player_id and (p.flagged_at is null or p.id = auth.uid());
$$;

grant execute on function public.update_profile(text, text, text, boolean, boolean) to authenticated;
grant execute on function public.get_profile(uuid) to anon, authenticated;

create or replace function public.report_player(p_target_player_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_reporter uuid := auth.uid();
  v_count integer;
begin
  if v_reporter is null then raise exception using errcode = '42501', message = 'not_authenticated'; end if;
  if v_reporter = p_target_player_id then raise exception using errcode = '22023', message = 'cannot_report_self'; end if;
  if not exists (select 1 from public.profiles where id = p_target_player_id) then raise exception using errcode = '22023', message = 'player_not_found'; end if;
  select count(*) into v_count from public.reports where reporter_id = v_reporter and created_at > now() - interval '1 hour';
  if v_count >= 5 then raise exception using errcode = 'P0001', message = 'report_rate_limited'; end if;
  if exists (select 1 from public.reports where reporter_id = v_reporter and target_player_id = p_target_player_id and created_at > now() - interval '24 hours') then
    raise exception using errcode = '23505', message = 'report_duplicate';
  end if;
  insert into public.reports(reporter_id, target_player_id, reason) values (v_reporter, p_target_player_id, btrim(p_reason));
  return jsonb_build_object('submitted', true);
end $$;

grant execute on function public.report_player(uuid, text) to authenticated;

revoke all on table public.profanity_terms from anon, authenticated;
revoke all on table public.reports from anon;

comment on function public.get_profile is 'Public profile projection. Private visibility is only returned to the owner.';
comment on function public.report_player is 'Player reports with five-per-hour and duplicate throttles.';
