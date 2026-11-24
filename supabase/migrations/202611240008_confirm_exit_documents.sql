begin;

create function public.confirm_parking_exit_document(target_parking uuid, release_number integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  agent uuid := auth.uid();
  release public.parking_exit_documents%rowtype;
  visit public.parking_visits%rowtype;
  ids uuid[];
  matched integer := 0;
  remaining integer := 0;
  confirmed_at timestamptz;
begin
  if agent is null or not exists (
    select 1 from public.parking_members where parking_id = target_parking and user_id = agent
  ) then
    raise exception 'Accès au parking refusé.' using errcode = '42501';
  end if;

  select * into release from public.parking_exit_documents
    where parking_id = target_parking and document_number = release_number for update;
  if not found then raise exception 'Aucun bon de sortie ne correspond à ce numéro.'; end if;
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
      remaining := remaining + 1;
    else
      confirmed_at := greatest(confirmed_at, visit.exited_at);
    end if;
  end loop;
  if matched <> cardinality(ids) then
    raise exception 'Un véhicule du bon est introuvable ou figure en double.';
  end if;

  if remaining > 0 then
    confirmed_at := clock_timestamp();
    update public.parking_visits
      set exited_at = greatest(confirmed_at, entered_at), exited_by = agent,
        exited_time_known = true, loading_note = release.reference
      where parking_id = target_parking and id = any(ids) and exited_at is null;
  end if;

  update public.parking_exit_documents
    set document = release.document || jsonb_build_object('confirmedAt', confirmed_at)
    where parking_id = target_parking and document_number = release_number;
  return confirmed_at;
end;
$$;

revoke all on function public.confirm_parking_exit_document(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.confirm_parking_exit_document(uuid, integer) to authenticated;
revoke execute on function public.depart_parking_vehicles(uuid, uuid[], text) from authenticated;

notify pgrst, 'reload schema';
commit;
