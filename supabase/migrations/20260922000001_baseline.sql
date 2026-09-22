-- RE:Arena baseline schema (WO-14).
-- Forward-only. Identity, player-owned data, RLS, and the ProfileProvisioner trigger.
-- Competitive tables (runs, verification_jobs, leaderboard_entries, ghosts, challenges) arrive in WO-53.
-- Content tables arrive in WO-8.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.run_status as enum ('pending', 'verified', 'rejected', 'invalidated');
create type public.release_status as enum ('draft', 'scheduled', 'published', 'rolled_back');

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user (see RE:Arena Backend blueprint, model Profile)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                      uuid primary key references auth.users (id) on delete cascade,
  display_name            citext not null unique,
  display_name_changed_at timestamptz,
  avatar_id               text not null default 'default',
  country                 char(2),
  xp                      integer not null default 0 check (xp >= 0),
  level                   integer not null default 1 check (level >= 1),
  hidden_from_boards      boolean not null default false,
  is_guest                boolean not null default true,
  flagged_at              timestamptz,
  created_at              timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  constraint profiles_display_name_len check (char_length(display_name::text) between 3 and 16),
  constraint profiles_display_name_chars check (display_name::text ~ '^[A-Za-z0-9_]+$')
);

comment on table public.profiles is 'Public identity and progression. Created by trigger on auth.users insert.';

-- Public read of non-sensitive profile columns is done through a view so RLS on the
-- base table can stay owner-only.
create view public.public_profiles as
  select id, display_name, avatar_id, country, level, is_guest, created_at
  from public.profiles
  where flagged_at is null;

-- ---------------------------------------------------------------------------
-- player_settings: one jsonb blob per player, versioned for last-write-wins sync
-- ---------------------------------------------------------------------------
create table public.player_settings (
  player_id  uuid primary key references public.profiles (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  version    integer not null default 1,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- loadouts: three slots per player
-- ---------------------------------------------------------------------------
create table public.loadouts (
  id               uuid primary key default gen_random_uuid(),
  player_id        uuid not null references public.profiles (id) on delete cascade,
  slot             smallint not null check (slot between 1 and 3),
  name             text not null default 'Loadout',
  primary_weapon   text not null,
  secondary_weapon text not null,
  perks            jsonb not null default '[]'::jsonb,
  updated_at       timestamptz not null default now(),
  unique (player_id, slot)
);

-- ---------------------------------------------------------------------------
-- unlocks: items a player has earned
-- ---------------------------------------------------------------------------
create table public.unlocks (
  player_id   uuid not null references public.profiles (id) on delete cascade,
  item_type   text not null check (item_type in ('weapon', 'attachment', 'perk', 'avatar')),
  item_id     text not null,
  unlocked_at timestamptz not null default now(),
  primary key (player_id, item_type, item_id)
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger player_settings_updated_at before update on public.player_settings
  for each row execute function public.set_updated_at();
create trigger loadouts_updated_at before update on public.loadouts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- ProfileProvisioner: create a profile for every new auth user
-- ---------------------------------------------------------------------------
create or replace function public.generate_display_name()
returns text language plpgsql as $$
declare
  adjectives text[] := array['Swift','Iron','Nova','Ghost','Rapid','Silent','Vector','Prime','Ember','Frost'];
  nouns      text[] := array['Fox','Hawk','Wolf','Viper','Raven','Lynx','Otter','Falcon','Cobra','Bison'];
  candidate  text;
  tries      integer := 0;
begin
  loop
    candidate := adjectives[1 + floor(random() * array_length(adjectives, 1))::int]
              || nouns[1 + floor(random() * array_length(nouns, 1))::int]
              || lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from public.profiles where display_name = candidate::citext);
    tries := tries + 1;
    if tries > 20 then
      candidate := 'Player' || replace(gen_random_uuid()::text, '-', '');
      candidate := left(candidate, 16);
      exit;
    end if;
  end loop;
  return candidate;
end $$;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, is_guest)
  values (new.id, public.generate_display_name(), coalesce(new.is_anonymous, false));
  insert into public.player_settings (player_id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- When a guest links a permanent identity, flip is_guest. auth.users.is_anonymous becomes false.
create or replace function public.handle_auth_user_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (old.is_anonymous is distinct from new.is_anonymous) and new.is_anonymous = false then
    update public.profiles set is_guest = false where id = new.id;
  end if;
  return new;
end $$;

create trigger on_auth_user_updated
  after update of is_anonymous on auth.users
  for each row execute function public.handle_auth_user_updated();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.player_settings enable row level security;
alter table public.loadouts        enable row level security;
alter table public.unlocks         enable row level security;

-- profiles: owner can read and update own row; public reads go through public_profiles view.
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- players cannot self-modify progression or moderation columns
    and xp = (select p.xp from public.profiles p where p.id = auth.uid())
    and level = (select p.level from public.profiles p where p.id = auth.uid())
    and flagged_at is not distinct from (select p.flagged_at from public.profiles p where p.id = auth.uid())
  );

grant select on public.public_profiles to anon, authenticated;

-- player_settings, loadouts, unlocks(select only): owner-only.
create policy player_settings_all_own on public.player_settings
  for all using (auth.uid() = player_id) with check (auth.uid() = player_id);

create policy loadouts_all_own on public.loadouts
  for all using (auth.uid() = player_id) with check (auth.uid() = player_id);

create policy unlocks_select_own on public.unlocks
  for select using (auth.uid() = player_id);
-- unlocks are inserted only by award_xp (WO-33) running as service role.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.player_settings to authenticated;
grant select, insert, update, delete on public.loadouts to authenticated;
grant select on public.unlocks to authenticated;
grant all on all tables in schema public to service_role;
