begin;

alter table public.parkings
  add column dedicated_capacity integer not null default 200 check (dedicated_capacity > 0);

alter table public.parking_visits
  add column key_number text check (key_number ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  add column aisle text check (aisle ~ '^[A-T]$'),
  add column make_model text check (char_length(make_model) between 1 and 100),
  add column loading_note text check (loading_note ~ '^[A-Z0-9][A-Z0-9./_-]{0,63}$'),
  add column entered_time_known boolean not null default true,
  add column exited_time_known boolean not null default true;

create unique index parking_visits_active_key
  on public.parking_visits (parking_id, key_number) where exited_at is null and key_number is not null;

create function public.receive_parking_vehicle(
  target_parking uuid, visit_id uuid, plate_text text, with_photo boolean,
  key_text text, aisle_text text, model_text text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  canonical_plate text := upper(normalize(plate_text, NFKC));
  saved public.parking_visits%rowtype;
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;
  if key_text is null or key_text !~ '^[A-Z0-9][A-Z0-9-]{0,31}$'
    or aisle_text is null or aisle_text !~ '^[A-T]$' then
    raise exception 'Le numéro de clé et une allée de A à T sont requis.';
  end if;
  insert into public.parking_visits (id, parking_id, plate, expects_photo, entered_by, key_number, aisle, make_model)
  values (visit_id, target_parking, canonical_plate, with_photo, agent, key_text, aisle_text, nullif(btrim(model_text), ''))
  on conflict (id) do nothing;
  select * into saved from public.parking_visits where id = visit_id and parking_id = target_parking;
  if not found or saved.entered_by is distinct from agent
    or saved.plate is distinct from canonical_plate or saved.expects_photo is distinct from with_photo then
    raise exception 'Cette tentative correspond à une autre entrée.';
  end if;
  return saved.id;
end;
$$;

create function public.update_parking_visit_details(
  target_parking uuid, visit_id uuid, key_text text, aisle_text text, model_text text, note_text text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = auth.uid()
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;
  if key_text is null or key_text !~ '^[A-Z0-9][A-Z0-9-]{0,31}$'
    or aisle_text is null or aisle_text !~ '^[A-T]$' then
    raise exception 'Le numéro de clé et une allée de A à T sont requis.';
  end if;
  update public.parking_visits
    set key_number = key_text, aisle = aisle_text, make_model = nullif(btrim(model_text), ''), loading_note = note_text
  where id = visit_id and parking_id = target_parking and exited_at is null;
  if not found then raise exception 'Le véhicule a déjà quitté le parking.'; end if;
end;
$$;

create function public.depart_parking_vehicles(target_parking uuid, visit_ids uuid[], note_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  departure_at timestamptz;
  visit public.parking_visits%rowtype;
  matched integer := 0;
  requested integer := cardinality(visit_ids);
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;
  if requested is null or requested < 1 or note_text is null or note_text !~ '^[A-Z0-9][A-Z0-9./_-]{0,63}$' then
    raise exception 'Sélectionne les véhicules et saisis un numéro de bon valide.';
  end if;
  for visit in
    select * from public.parking_visits where parking_id = target_parking and id = any(visit_ids)
    order by id for update
  loop
    matched := matched + 1;
    if visit.exited_at is not null and
      (visit.loading_note is distinct from note_text or visit.exited_by is distinct from agent) then
      raise exception 'Un véhicule sélectionné est déjà sorti. Actualise le registre.';
    end if;
  end loop;
  if matched <> requested then raise exception 'La sélection contient un séjour introuvable ou en double.'; end if;
  departure_at := clock_timestamp();
  update public.parking_visits
    set exited_at = greatest(departure_at, entered_at), exited_by = agent, loading_note = note_text
  where parking_id = target_parking and id = any(visit_ids) and exited_at is null;
end;
$$;

revoke execute on function public.register_parking_entry(uuid, uuid, text, boolean) from authenticated;
revoke execute on function public.register_parking_exit(uuid, uuid) from authenticated;
revoke all on function public.receive_parking_vehicle(uuid, uuid, text, boolean, text, text, text),
  public.update_parking_visit_details(uuid, uuid, text, text, text, text),
  public.depart_parking_vehicles(uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.receive_parking_vehicle(uuid, uuid, text, boolean, text, text, text),
  public.update_parking_visit_details(uuid, uuid, text, text, text, text),
  public.depart_parking_vehicles(uuid, uuid[], text) to authenticated;

notify pgrst, 'reload schema';
commit;
