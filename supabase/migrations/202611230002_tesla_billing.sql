begin;

create table public.parking_visit_billing (
  visit_id uuid primary key references public.parking_visits(id) on delete cascade
);

create table public.parking_visit_services (
  id uuid primary key,
  visit_id uuid not null references public.parking_visit_billing(visit_id),
  kind text not null check (kind in ('photos', 'inspection', 'exterior', 'full_wash')),
  performed_on date not null
);
create index parking_visit_services_visit on public.parking_visit_services (visit_id, performed_on);

alter table public.parking_visit_billing enable row level security;
alter table public.parking_visit_services enable row level security;
revoke all on public.parking_visit_billing, public.parking_visit_services from public, anon, authenticated;
grant select, insert, delete on public.parking_visit_billing, public.parking_visit_services to authenticated;

-- The existing visits policy restricts every lookup to parking members.
create policy "Read Tesla assignments" on public.parking_visit_billing for select to authenticated
  using (exists (select 1 from public.parking_visits where id = visit_id));
create policy "Assign Tesla visits" on public.parking_visit_billing for insert to authenticated
  with check (exists (select 1 from public.parking_visits where id = visit_id));
create policy "Remove Tesla assignments" on public.parking_visit_billing for delete to authenticated
  using (exists (select 1 from public.parking_visits where id = visit_id));

create policy "Read assigned Tesla services" on public.parking_visit_services for select to authenticated
  using (exists (
    select 1 from public.parking_visit_billing as billing
    where billing.visit_id = parking_visit_services.visit_id
  ));
create policy "Record assigned Tesla services" on public.parking_visit_services for insert to authenticated
  with check (exists (
    select 1 from public.parking_visit_billing as billing
    join public.parking_visits as visit on visit.id = billing.visit_id
    where billing.visit_id = parking_visit_services.visit_id
      and performed_on >= (visit.entered_at at time zone 'Europe/Paris')::date
      and performed_on <= (coalesce(visit.exited_at, now()) at time zone 'Europe/Paris')::date
      and performed_on <= (now() at time zone 'Europe/Paris')::date
  ));
create policy "Remove assigned Tesla services" on public.parking_visit_services for delete to authenticated
  using (exists (
    select 1 from public.parking_visit_billing as billing
    where billing.visit_id = parking_visit_services.visit_id
  ));

notify pgrst, 'reload schema';
commit;
