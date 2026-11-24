begin;

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
    where parking_id = target_parking and reference = note_ref;
  if found then
    if (existing.source_data - 'pickupLocation') <> (loading - 'pickupLocation')
      or (nullif(existing.document->>'pickupLocation', '') is not null
        and existing.document->>'pickupLocation' <> pickup_location) then
      raise exception 'Un document différent existe déjà pour ce numéro de chargement.';
    end if;
    if nullif(existing.document->>'pickupLocation', '') is null then
      result := existing.document || jsonb_build_object('pickupLocation', pickup_location);
      update public.parking_exit_documents set source_data = loading, document = result
        where parking_id = target_parking and reference = note_ref;
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
    rows := rows || jsonb_build_array(jsonb_build_object(
      'plate', item->>'plate', 'makeModel', item->>'makeModel',
      'aisle', visit.aisle, 'keyNumber', visit.key_number, 'visitId', visit.id
    ));
  end loop;

  result := (loading - 'vehicles') || jsonb_build_object('number', sequence_number, 'rows', rows);
  insert into public.parking_exit_documents (parking_id, reference, document_number, source_data, document, created_by)
    values (target_parking, note_ref, sequence_number, loading, result, agent);
  update public.parkings set next_release_number = next_release_number + 1 where id = target_parking;
  return result;
end;
$$;

notify pgrst, 'reload schema';
commit;
