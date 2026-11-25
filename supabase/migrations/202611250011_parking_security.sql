begin;

alter table public.parking_members
  add column role text not null default 'agent' check (role in ('agent', 'responsable'));

alter table public.parkings
  add column mfa_policy text not null default 'optional'
    check (mfa_policy in ('optional', 'responsables', 'all'));

alter table public.parking_visit_services
  add column recorded_by uuid default auth.uid() references auth.users(id) on delete set null;

update storage.buckets set public = false where id = 'parko-plates';
revoke insert, delete on public.parking_visit_billing from authenticated;

create schema parko_private;
revoke all on schema parko_private from public;
grant usage on schema parko_private to authenticated;

create function parko_private.can_access(target uuid, required_role text default 'agent')
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.parking_members member
    join public.parkings parking on parking.id = member.parking_id
    where member.parking_id = target and member.user_id = (select auth.uid())
      and (required_role = 'agent' or (required_role = 'responsable' and member.role = 'responsable'))
      and (
        parking.mfa_policy = 'optional'
        or (parking.mfa_policy = 'responsables' and member.role = 'agent')
        or (select auth.jwt()->>'aal') = 'aal2'
      )
  );
$$;
revoke all on function parko_private.can_access(uuid, text) from public, anon, authenticated;
grant execute on function parko_private.can_access(uuid, text) to authenticated;

create function public.read_parking_access(target_parking uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'role', m.role,
    'mfaRequired', p.mfa_policy = 'all' or (p.mfa_policy = 'responsables' and m.role = 'responsable')
  )
  from public.parking_members m
  join public.parkings p on p.id = m.parking_id
  where m.parking_id = target_parking and m.user_id = (select auth.uid());
$$;
revoke all on function public.read_parking_access(uuid) from public, anon, authenticated;
grant execute on function public.read_parking_access(uuid) to authenticated;

alter policy "Read assigned parking" on public.parkings
  using (parko_private.can_access(id));
alter policy "Read assigned visits" on public.parking_visits
  using (parko_private.can_access(parking_id));
alter policy "Read exit documents for own parking" on public.parking_exit_documents
  using (parko_private.can_access(parking_id));

alter policy "Read parking services" on public.parking_visit_services
  using (exists (
    select 1 from public.parking_visits visit where visit.id = parking_visit_services.visit_id
      and (parking_visit_services.recorded_by = (select auth.uid())
           or parko_private.can_access(visit.parking_id, 'responsable'))
  ));

alter policy "Remove parking services" on public.parking_visit_services
  using (exists (
    select 1 from public.parking_visits visit where visit.id = parking_visit_services.visit_id
      and parko_private.can_access(visit.parking_id, 'responsable')
  ));

alter policy "Record parking services" on public.parking_visit_services
  with check (
    (select auth.uid()) = recorded_by
    and exists (select 1 from pg_timezone_names where name = parking_visit_services.time_zone)
    and exists (
      select 1 from public.parking_visits as visit
      where visit.id = parking_visit_services.visit_id
        and performed_on >= (visit.entered_at at time zone
          case when visit.entered_time_known then parking_visit_services.time_zone else 'Europe/Paris' end)::date
        and performed_on <= case
          when visit.exited_at is not null and not visit.exited_time_known
            then (visit.exited_at at time zone 'Europe/Paris')::date
          else (coalesce(visit.exited_at, now()) at time zone parking_visit_services.time_zone)::date
        end
        and performed_on <= (now() at time zone parking_visit_services.time_zone)::date
    )
  );

create or replace function public.receive_parking_vehicle(
  target_parking uuid, visit_id uuid, plate_text text, with_photo boolean,
  key_text text, aisle_text text, model_text text, device_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  canonical_plate text := upper(normalize(plate_text, NFKC));
  saved public.parking_visits%rowtype;
  recorded_at timestamptz := clock_timestamp();
begin
  if not parko_private.can_access(target_parking) then
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
  if not parko_private.can_access(target_parking) then
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
  if not parko_private.can_access(target_parking) then
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

create or replace function public.confirm_parking_exit_document(target_parking uuid, release_number integer, device_at timestamptz default null)
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
  if not parko_private.can_access(target_parking) then
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

create or replace function public.cancel_parking_exit_document(target_parking uuid, release_number integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  release public.parking_exit_documents%rowtype;
  cancelled timestamptz := clock_timestamp();
  result jsonb;
begin
  if not parko_private.can_access(target_parking, 'responsable') then
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

create or replace function public.read_parking_reports(target_parking uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'asOf', statement_timestamp(),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id,
        'plate', v.plate,
        'entryAt', v.entered_at,
        'exitAt', v.exited_at,
        'keyNumber', v.key_number,
        'aisle', v.aisle,
        'makeModel', v.make_model,
        'loadingNote', v.loading_note,
        'entryTimeKnown', v.entered_time_known,
        'exitTimeKnown', v.exited_time_known,
        'entryAgentId', v.entered_by,
        'exitAgentId', v.exited_by,
        'photoUri', null::text,
        'hasPhoto', v.expects_photo and exists (
          select 1 from storage.objects as photo
          where photo.bucket_id = 'parko-plates'
            and photo.name = v.parking_id::text || '/' || v.id::text
        ),
        'billing', jsonb_build_object('services', coalesce((
          select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'performedOn', s.performed_on)
            order by s.performed_on, s.id)
          from public.parking_visit_services as s where s.visit_id = v.id and parko_private.can_access(target_parking, 'responsable')
        ), '[]'::jsonb))
      ) order by v.entered_at desc, v.id)
      from public.parking_visits as v where v.parking_id = target_parking
    ), '[]'::jsonb)
  )
  where parko_private.can_access(target_parking);
$$;

create table public.parking_audit (
  id bigint generated always as identity primary key,
  parking_id uuid not null references public.parkings(id),
  actor_id uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  action text not null,
  reference text not null,
  changed_fields text[] not null default '{}'
);
create index parking_audit_by_parking on public.parking_audit(parking_id, recorded_at desc);
alter table public.parking_audit enable row level security;
revoke all on public.parking_audit from public, anon, authenticated;
grant select on public.parking_audit to authenticated;
create policy "Read parking audit for managers" on public.parking_audit for select to authenticated
  using (parko_private.can_access(parking_id, 'responsable'));

create function parko_private.audit_parking_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
  event_name text;
  item text;
  fields text[] := '{}';
begin
  case tg_table_name
    when 'parking_visits' then
      target := new.parking_id;
      item := new.id::text;
      if tg_op = 'INSERT' then
        event_name := 'entree_enregistree';
      else
        select coalesce(array_agg(change.key order by change.key), '{}') into fields
        from jsonb_each(to_jsonb(new)) change
        where change.key = any(array['plate', 'key_number', 'aisle', 'make_model', 'loading_note', 'exited_at'])
          and change.value is distinct from (to_jsonb(old)->change.key);
        if cardinality(fields) = 0 then return null; end if;
        event_name := case when old.exited_at is null and new.exited_at is not null
          then 'sortie_enregistree' else 'fiche_modifiee' end;
      end if;
    when 'parking_exit_documents' then
      target := new.parking_id;
      item := new.document_number::text;
      if tg_op = 'INSERT' then
        event_name := 'bon_cree';
      elsif old.cancelled_at is null and new.cancelled_at is not null then
        event_name := 'bon_annule';
      elsif old.document->>'confirmedAt' is null and new.document->>'confirmedAt' is not null then
        event_name := 'bon_valide';
      else
        return null;
      end if;
    when 'parking_visit_services' then
      if tg_op = 'DELETE' then
        item := old.id::text;
        select v.parking_id into target from public.parking_visits v where v.id = old.visit_id;
        event_name := 'prestation_retiree';
      else
        item := new.id::text;
        select v.parking_id into target from public.parking_visits v where v.id = new.visit_id;
        event_name := 'prestation_ajoutee';
      end if;
      -- A maintenance cascade can already have deleted the parent visit.
      if target is null then return null; end if;
    else
      raise exception 'Table non prise en charge par le journal PARKO.';
  end case;

  insert into public.parking_audit(parking_id, actor_id, action, reference, changed_fields)
    values (target, auth.uid(), event_name, item, fields);
  return null;
end;
$$;
revoke all on function parko_private.audit_parking_changes() from public, anon, authenticated;

create trigger audit_parking_visits after insert or update on public.parking_visits
  for each row execute function parko_private.audit_parking_changes();
create trigger audit_parking_exit_documents after insert or update on public.parking_exit_documents
  for each row execute function parko_private.audit_parking_changes();
create trigger audit_parking_visit_services after insert or delete on public.parking_visit_services
  for each row execute function parko_private.audit_parking_changes();

notify pgrst, 'reload schema';
commit;
