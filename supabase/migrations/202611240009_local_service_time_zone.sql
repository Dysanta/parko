begin;

-- Existing services and older clients used the Paris calendar.
alter table public.parking_visit_services
  add column time_zone text not null default 'Europe/Paris';

alter policy "Record parking services" on public.parking_visit_services
  with check (
    exists (select 1 from pg_timezone_names where name = parking_visit_services.time_zone)
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

notify pgrst, 'reload schema';
commit;
