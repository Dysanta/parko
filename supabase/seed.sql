-- Comptes fictifs du Supabase local. Aucune donnée réelle.
create extension if not exists pgcrypto with schema extensions;

insert into public.parkings (id, name, mfa_policy)
values ('10000000-0000-4000-8000-000000000001', 'PARKO — Test local', 'all')
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
       extensions.crypt('Parko-Local-2026!', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
       '', '', '', ''
from (values
  ('10000000-0000-4000-8000-000000000011'::uuid, 'agent@parko.example'),
  ('10000000-0000-4000-8000-000000000012'::uuid, 'responsable@parko.example'),
  ('10000000-0000-4000-8000-000000000013'::uuid, 'externe@parko.example')
) as accounts(id, email)
on conflict (id) do nothing;

insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
select id, id::text, id, jsonb_build_object('sub', id, 'email', email, 'email_verified', true), 'email', now(), now(), now()
from auth.users where id in (
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000013'
)
on conflict (provider_id, provider) do nothing;

insert into public.parking_members (parking_id, user_id, role)
values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'agent'),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000012', 'responsable')
on conflict (parking_id, user_id) do nothing;
