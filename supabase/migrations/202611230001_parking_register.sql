begin;

create table public.parkings (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.parking_members (
  parking_id uuid not null references public.parkings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (parking_id, user_id)
);

create table public.parking_visits (
  id uuid primary key,
  parking_id uuid not null references public.parkings(id),
  plate text not null check (plate ~ '^[[:alnum:]]{1,32}$' and plate = upper(plate)),
  entered_at timestamptz not null default clock_timestamp(),
  entered_by uuid default auth.uid() references auth.users(id) on delete set null,
  exited_at timestamptz check (exited_at >= entered_at),
  exited_by uuid references auth.users(id) on delete set null,
  expects_photo boolean not null default false
);

create unique index parking_visits_active_plate
  on public.parking_visits (parking_id, plate) where exited_at is null;
create index parking_visits_history
  on public.parking_visits (parking_id, entered_at desc, id desc);

alter table public.parkings enable row level security;
alter table public.parking_members enable row level security;
alter table public.parking_visits enable row level security;

revoke all on public.parkings, public.parking_members, public.parking_visits
  from public, anon, authenticated;
grant select on public.parkings, public.parking_members, public.parking_visits to authenticated;

create policy "Read own memberships" on public.parking_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Read assigned parking" on public.parkings for select to authenticated
  using (exists (select 1 from public.parking_members where parking_id = parkings.id));
create policy "Read assigned visits" on public.parking_visits for select to authenticated
  using (exists (
    select 1 from public.parking_members where parking_id = parking_visits.parking_id
  ));

create function public.register_parking_entry(
  target_parking uuid, visit_id uuid, plate_text text, with_photo boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  canonical_plate text := upper(normalize(plate_text, NFKC));
  saved_id uuid;
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;

  insert into public.parking_visits (id, parking_id, plate, expects_photo, entered_by)
  values (visit_id, target_parking, canonical_plate, with_photo, agent)
  on conflict (id) do nothing;

  select id into saved_id from public.parking_visits
  where id = visit_id and parking_id = target_parking and entered_by = agent
    and plate = canonical_plate and expects_photo = with_photo;
  if saved_id is null then
    raise exception 'Cette tentative correspond à une autre entrée.';
  end if;
  return saved_id;
end;
$$;

create function public.register_parking_exit(target_parking uuid, visit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;

  update public.parking_visits
  set exited_at = greatest(clock_timestamp(), entered_at), exited_by = agent
  where id = visit_id and parking_id = target_parking and exited_at is null;
end;
$$;

revoke all on function public.register_parking_entry(uuid, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.register_parking_exit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_parking_entry(uuid, uuid, text, boolean)
  to authenticated;
grant execute on function public.register_parking_exit(uuid, uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('parko-plates', 'parko-plates', false, 8388608,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

create policy "Read assigned plate photos" on storage.objects for select to authenticated
  using (bucket_id = 'parko-plates' and exists (
    select 1 from public.parking_visits as visit
    where name = visit.parking_id::text || '/' || visit.id::text and visit.expects_photo
  ));

create policy "Upload photo for own entry" on storage.objects for insert to authenticated
  with check (bucket_id = 'parko-plates' and exists (
    select 1 from public.parking_visits as visit
    where name = visit.parking_id::text || '/' || visit.id::text and visit.expects_photo
      and visit.entered_by = (select auth.uid())
  ));

commit;
