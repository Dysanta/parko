begin;

alter table public.parking_visit_services
  drop constraint parking_visit_services_visit_id_fkey,
  add constraint parking_visit_services_visit_id_fkey
    foreign key (visit_id) references public.parking_visits(id) on delete cascade;

drop policy "Read assigned Tesla services" on public.parking_visit_services;
drop policy "Record assigned Tesla services" on public.parking_visit_services;
drop policy "Remove assigned Tesla services" on public.parking_visit_services;

-- Access follows the visit policy for the corresponding parking.
create policy "Read parking services" on public.parking_visit_services for select to authenticated
  using (exists (
    select 1 from public.parking_visits as visit where visit.id = parking_visit_services.visit_id
  ));

create policy "Record parking services" on public.parking_visit_services for insert to authenticated
  with check (exists (
    select 1 from public.parking_visits as visit
    where visit.id = parking_visit_services.visit_id
      and performed_on >= (visit.entered_at at time zone 'Europe/Paris')::date
      and performed_on <= (coalesce(visit.exited_at, now()) at time zone 'Europe/Paris')::date
      and performed_on <= (now() at time zone 'Europe/Paris')::date
  ));

create policy "Remove parking services" on public.parking_visit_services for delete to authenticated
  using (exists (
    select 1 from public.parking_visits as visit where visit.id = parking_visit_services.visit_id
  ));

notify pgrst, 'reload schema';
commit;
