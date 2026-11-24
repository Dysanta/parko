begin;

-- A single statement reads visits and services from the same database snapshot.
create function public.read_parking_reports(target_parking uuid)
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
          from public.parking_visit_services as s where s.visit_id = v.id
        ), '[]'::jsonb))
      ) order by v.entered_at desc, v.id)
      from public.parking_visits as v where v.parking_id = target_parking
    ), '[]'::jsonb)
  )
  where auth.uid() is not null and exists (
    select 1 from public.parking_members as member
    where member.parking_id = target_parking and member.user_id = auth.uid()
  );
$$;

revoke all on function public.read_parking_reports(uuid) from public, anon, authenticated;
grant execute on function public.read_parking_reports(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
