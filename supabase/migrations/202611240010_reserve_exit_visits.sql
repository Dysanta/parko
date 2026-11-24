begin;

alter table public.parking_exit_documents drop constraint parking_exit_documents_pkey,
  add column cancelled_at timestamptz;

create unique index parking_exit_documents_pending_reference
  on public.parking_exit_documents (parking_id, reference)
  where cancelled_at is null;

create table public.parking_exit_reservations (
  visit_id uuid primary key references public.parking_visits(id) on delete cascade,
  parking_id uuid not null,
  document_number integer not null,
  foreign key (parking_id, document_number)
    references public.parking_exit_documents(parking_id, document_number) on delete cascade
);
create index parking_exit_reservations_document on public.parking_exit_reservations(parking_id, document_number);
alter table public.parking_exit_reservations enable row level security;
revoke all on public.parking_exit_reservations from public, anon, authenticated;

alter table public.parking_visits
  add column entry_recorded_at timestamptz,
  add column exit_recorded_at timestamptz;

-- Preserve the numbers and contents of legacy documents. Reserve the oldest usable
-- document first and archive later duplicates as cancelled so they cannot be used.
do $$
declare
  release public.parking_exit_documents%rowtype;
  ids uuid[];
  incompatible boolean;
  active_count integer;
  last_exit timestamptz;
  cancelled timestamptz := statement_timestamp();
begin
  for release in select * from public.parking_exit_documents
    where document->>'confirmedAt' is null order by parking_id, document_number
  loop
    select array_agg((item->>'visitId')::uuid) into ids
      from jsonb_array_elements(release.document->'rows') as rows(item);
    select count(*) <> cardinality(ids)
      or coalesce(bool_or((v.exited_at is not null or v.loading_note is not null)
        and v.loading_note is distinct from release.reference), false)
      or coalesce(bool_or(reservation.visit_id is not null), false),
      count(*) filter (where v.exited_at is null), max(v.exited_at)
      into incompatible, active_count, last_exit
      from public.parking_visits v
      left join public.parking_exit_reservations reservation on reservation.visit_id = v.id
      where v.parking_id = release.parking_id and v.id = any(ids);
    if ids is null or incompatible then
      update public.parking_exit_documents
        set cancelled_at = cancelled, document = document || jsonb_build_object(
          'cancelledAt', cancelled, 'cancellationReason', 'Véhicule déjà affecté à un autre bon ou séjour indisponible.')
        where parking_id = release.parking_id and document_number = release.document_number;
    elsif active_count = 0 then
      update public.parking_exit_documents
        set document = document || jsonb_build_object('confirmedAt', last_exit)
        where parking_id = release.parking_id and document_number = release.document_number;
    else
      insert into public.parking_exit_reservations (visit_id, parking_id, document_number)
        select id, release.parking_id, release.document_number from public.parking_visits
        where parking_id = release.parking_id and id = any(ids) and exited_at is null;
    end if;
  end loop;
end;
$$;

drop function public.receive_parking_vehicle(uuid, uuid, text, boolean, text, text, text);
drop function public.confirm_parking_exit_document(uuid, integer);

create function public.receive_parking_vehicle(
  target_parking uuid, visit_id uuid, plate_text text, with_photo boolean,
  key_text text, aisle_text text, model_text text, device_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  canonical_plate text := upper(normalize(plate_text, NFKC));
  saved public.parking_visits%rowtype;
  recorded_at timestamptz := clock_timestamp();
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
  if device_at is not null and not isfinite(device_at) then
    raise exception 'L’heure de l’appareil est invalide.';
  end if;
  insert into public.parking_visits (id, parking_id, plate, expects_photo, entered_by, key_number, aisle, make_model,
    entered_at, entry_recorded_at)
  values (visit_id, target_parking, canonical_plate, with_photo, agent, key_text, aisle_text, nullif(btrim(model_text), ''),
    coalesce(device_at, recorded_at), recorded_at)
  on conflict (id) do nothing;
  select * into saved from public.parking_visits where id = visit_id and parking_id = target_parking;
  if not found or saved.entered_by is distinct from agent
    or saved.plate is distinct from canonical_plate or saved.expects_photo is distinct from with_photo then
    raise exception 'Cette tentative correspond à une autre entrée.';
  end if;
  return saved.id;
end;
$$;

create or replace function public.update_parking_visit_details(
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
  perform 1 from public.parkings where id = target_parking for update;
  if exists (
    select 1 from public.parking_exit_reservations as reservation
    join public.parking_visits as visit on visit.id = reservation.visit_id
    where reservation.visit_id = update_parking_visit_details.visit_id and reservation.parking_id = target_parking
      and (visit.key_number is distinct from key_text or visit.aisle is distinct from aisle_text
        or visit.loading_note is distinct from note_text)
  ) then
    raise exception 'Annule le bon de sortie avant de changer la clé, l’allée ou le bon associé.';
  end if;
  update public.parking_visits
    set key_number = key_text, aisle = aisle_text, make_model = nullif(btrim(model_text), ''), loading_note = note_text
  where id = visit_id and parking_id = target_parking and exited_at is null;
  if not found then raise exception 'Le véhicule a déjà quitté le parking.'; end if;
end;
$$;

create or replace function public.issue_parking_exit_document(target_parking uuid, loading jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  note_ref text := loading->>'reference';
  pickup_location text := btrim(loading->>'pickupLocation');
  item jsonb;
  rows jsonb := '[]'::jsonb;
  existing public.parking_exit_documents%rowtype;
  visit public.parking_visits%rowtype;
  found_ids uuid[];
  sequence_number integer;
  assigned_number integer;
  result jsonb;
begin
  if agent is null or not exists (
    select 1 from public.parking_members member
    where member.parking_id = target_parking and member.user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;
  if jsonb_typeof(loading) is distinct from 'object'
    or loading - array['reference', 'lot', 'pickupDate', 'pickupLocation', 'transport', 'vehicles'] <> '{}'::jsonb
    or note_ref is null or note_ref !~ '^[A-Z0-9][A-Z0-9./_-]{0,63}$'
    or coalesce(length(btrim(loading->>'lot')), 0) not between 1 and 64
    or coalesce(length(btrim(loading->>'transport')), 0) not between 1 and 200
    or coalesce(length(pickup_location), 0) not between 1 and 350
    or coalesce(loading->>'pickupDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(loading->'vehicles') is distinct from 'array' then
    raise exception 'Le bon de chargement transmis est incomplet.';
  end if;
  loading := jsonb_set(loading, '{pickupLocation}', to_jsonb(pickup_location));
  perform (loading->>'pickupDate')::date;
  if jsonb_array_length(loading->'vehicles') not between 1 and 200 or exists (
    select 1 from jsonb_array_elements(loading->'vehicles') as row_data(value)
    group by value->>'plate' having count(*) > 1
  ) then raise exception 'Le bon contient un nombre de véhicules invalide ou des plaques en double.'; end if;

  select next_release_number into sequence_number from public.parkings
    where id = target_parking for update;
  select * into existing from public.parking_exit_documents
    where parking_id = target_parking and reference = note_ref and cancelled_at is null;
  if found then
    if (existing.source_data - 'pickupLocation') <> (loading - 'pickupLocation')
      or (nullif(existing.document->>'pickupLocation', '') is not null
        and existing.document->>'pickupLocation' <> pickup_location) then
      raise exception 'Un document différent existe déjà pour ce numéro de chargement.';
    end if;
    if nullif(existing.document->>'pickupLocation', '') is null then
      result := existing.document || jsonb_build_object('pickupLocation', pickup_location);
      update public.parking_exit_documents set source_data = loading, document = result
        where parking_id = target_parking and reference = note_ref and cancelled_at is null;
      return result;
    end if;
    return existing.document;
  end if;

  for item in select value from jsonb_array_elements(loading->'vehicles') loop
    if jsonb_typeof(item) is distinct from 'object' or item - array['plate', 'makeModel'] <> '{}'::jsonb
      or coalesce(item->>'plate', '') !~ '^[A-Z0-9]{1,32}$'
      or coalesce(length(btrim(item->>'makeModel')), 0) not between 1 and 100 then
      raise exception 'Une ligne véhicule du bon est invalide.';
    end if;
    select array_agg(v.id) into found_ids from public.parking_visits v
      where v.parking_id = target_parking and v.plate = (item->>'plate') and v.loading_note = note_ref;
    if found_ids is null then
      select array_agg(v.id) into found_ids from public.parking_visits v
        where v.parking_id = target_parking and v.plate = (item->>'plate')
          and v.exited_at is null and v.loading_note is null;
    end if;
    if cardinality(found_ids) is distinct from 1 then
      raise exception 'Véhicule absent ou ambigu : %.', item->>'plate';
    end if;
    select * into visit from public.parking_visits where id = found_ids[1] for share;
    if not found or visit.key_number is null or visit.aisle is null or
      (visit.loading_note is distinct from note_ref and (visit.exited_at is not null or visit.loading_note is not null)) then
      raise exception 'La fiche de % a changé ou doit être complétée.', item->>'plate';
    end if;
    select reservation.document_number into assigned_number from public.parking_exit_reservations reservation
      where reservation.visit_id = visit.id;
    if found then
      raise exception 'Le véhicule % est déjà réservé par le bon de sortie n° %.',
        visit.plate, lpad(assigned_number::text, greatest(6, length(assigned_number::text)), '0');
    end if;
    rows := rows || jsonb_build_array(jsonb_build_object(
      'plate', item->>'plate', 'makeModel', item->>'makeModel',
      'aisle', visit.aisle, 'keyNumber', visit.key_number, 'visitId', visit.id
    ));
  end loop;

  result := (loading - 'vehicles') || jsonb_build_object('number', sequence_number, 'rows', rows);
  insert into public.parking_exit_documents (parking_id, reference, document_number, source_data, document, created_by)
    values (target_parking, note_ref, sequence_number, loading, result, agent);
  insert into public.parking_exit_reservations (visit_id, parking_id, document_number)
    select v.id, target_parking, sequence_number
    from jsonb_array_elements(rows) as item(value)
    join public.parking_visits v on v.id = (item.value->>'visitId')::uuid
    where v.exited_at is null;
  update public.parkings set next_release_number = next_release_number + 1 where id = target_parking;
  return result;
end;
$$;

create function public.confirm_parking_exit_document(target_parking uuid, release_number integer, device_at timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  release public.parking_exit_documents%rowtype;
  visit public.parking_visits%rowtype;
  ids uuid[];
  matched integer := 0;
  remaining integer := 0;
  confirmed_at timestamptz;
  recorded_at timestamptz := clock_timestamp();
  latest_entry timestamptz;
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;

  perform 1 from public.parkings where id = target_parking for update;
  select * into release from public.parking_exit_documents
    where parking_id = target_parking and document_number = release_number for update;
  if not found then raise exception 'Aucun bon de sortie ne correspond à ce numéro.'; end if;
  if release.cancelled_at is not null then raise exception 'Ce bon de sortie a été annulé.'; end if;
  if release.document->>'confirmedAt' is not null then
    return (release.document->>'confirmedAt')::timestamptz;
  end if;

  select array_agg((vehicle->>'visitId')::uuid) into ids
    from jsonb_array_elements(release.document->'rows') as rows(vehicle);
  if ids is null then raise exception 'Le bon de sortie ne contient aucun véhicule.'; end if;

  for visit in
    select * from public.parking_visits
    where parking_id = target_parking and id = any(ids)
    order by id for update
  loop
    matched := matched + 1;
    if (visit.exited_at is not null or visit.loading_note is not null)
      and visit.loading_note is distinct from release.reference then
      raise exception 'Le véhicule % est déjà sorti ou associé à un autre bon.', visit.plate;
    end if;
    if visit.exited_at is null then
      if not exists (select 1 from public.parking_exit_reservations
        where visit_id = visit.id and parking_id = target_parking and document_number = release_number) then
        raise exception 'La réservation de % ne correspond plus au bon.', visit.plate;
      end if;
      remaining := remaining + 1;
      latest_entry := greatest(latest_entry, visit.entered_at);
    else
      confirmed_at := greatest(confirmed_at, visit.exited_at);
    end if;
  end loop;
  if matched <> cardinality(ids) then
    raise exception 'Un véhicule du bon est introuvable ou figure en double.';
  end if;

  if remaining > 0 then
    if device_at is not null and (not isfinite(device_at) or device_at < latest_entry) then
      raise exception 'L’heure de l’appareil est invalide ou antérieure à une entrée. Vérifie l’horloge.';
    end if;
    confirmed_at := greatest(coalesce(device_at, recorded_at), confirmed_at);
    update public.parking_visits
      set exited_at = greatest(confirmed_at, entered_at), exited_by = agent,
        exited_time_known = true, exit_recorded_at = recorded_at, loading_note = release.reference
      where parking_id = target_parking and id = any(ids) and exited_at is null;
  end if;

  update public.parking_exit_documents
    set document = release.document || jsonb_build_object('confirmedAt', confirmed_at)
    where parking_id = target_parking and document_number = release_number;
  delete from public.parking_exit_reservations
    where parking_id = target_parking and document_number = release_number;
  return confirmed_at;
end;
$$;

create function public.cancel_parking_exit_document(target_parking uuid, release_number integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  release public.parking_exit_documents%rowtype;
  cancelled timestamptz := clock_timestamp();
  result jsonb;
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;

  perform 1 from public.parkings where id = target_parking for update;
  select * into release from public.parking_exit_documents
    where parking_id = target_parking and document_number = release_number for update;
  if not found then raise exception 'Aucun bon de sortie ne correspond à ce numéro.'; end if;
  if release.cancelled_at is not null then return release.document; end if;
  if release.document->>'confirmedAt' is not null then raise exception 'Cet enlèvement est déjà validé.'; end if;

  result := release.document || jsonb_build_object('cancelledAt', cancelled);
  update public.parking_exit_documents set cancelled_at = cancelled, document = result
    where parking_id = target_parking and document_number = release_number;
  delete from public.parking_exit_reservations
    where parking_id = target_parking and document_number = release_number;
  return result;
end;
$$;

revoke all on function public.receive_parking_vehicle(uuid, uuid, text, boolean, text, text, text, timestamptz),
  public.confirm_parking_exit_document(uuid, integer, timestamptz),
  public.cancel_parking_exit_document(uuid, integer) from public, anon, authenticated;
grant execute on function public.receive_parking_vehicle(uuid, uuid, text, boolean, text, text, text, timestamptz),
  public.confirm_parking_exit_document(uuid, integer, timestamptz),
  public.cancel_parking_exit_document(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
