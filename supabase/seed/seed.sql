-- Local development seed. Applied by `supabase db reset`. Never run in production.
-- Creates three fake players with settings and one loadout each.

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'arjun@example.test',  crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, now(), now()),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'priya@example.test',  crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, now(), now()),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, null, null, '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now())
on conflict (id) do nothing;

-- The trigger created profiles with generated names; give the seeded users readable ones.
update public.profiles set display_name = 'Arjun_Desktop', is_guest = false, xp = 1200, level = 4 where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set display_name = 'Priya_Mobile',  is_guest = false, xp = 300,  level = 2 where id = '00000000-0000-0000-0000-000000000002';

insert into public.loadouts (player_id, slot, name, primary_weapon, secondary_weapon)
values
  ('00000000-0000-0000-0000-000000000001', 1, 'Rifle', 'rifle-01', 'pistol-01'),
  ('00000000-0000-0000-0000-000000000002', 1, 'SMG',   'smg-01',   'pistol-01')
on conflict (player_id, slot) do nothing;

insert into public.unlocks (player_id, item_type, item_id)
values
  ('00000000-0000-0000-0000-000000000001', 'weapon', 'rifle-01'),
  ('00000000-0000-0000-0000-000000000001', 'weapon', 'smg-01'),
  ('00000000-0000-0000-0000-000000000001', 'weapon', 'pistol-01'),
  ('00000000-0000-0000-0000-000000000002', 'weapon', 'smg-01'),
  ('00000000-0000-0000-0000-000000000002', 'weapon', 'pistol-01')
on conflict do nothing;
