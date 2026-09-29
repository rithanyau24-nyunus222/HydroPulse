create extension if not exists "uuid-ossp";

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  staleness_window_minutes int not null default 10
);

insert into public.settings (id, staleness_window_minutes)
values (1, 10)
on conflict (id) do nothing;

create table if not exists public.standards (
  parameter text primary key,
  unit text,
  min_value numeric,
  max_value numeric,
  mandatory boolean not null default true,
  measurement text not null check (measurement in ('live', 'lab')),
  max_age_minutes int not null default 10,
  weight numeric,
  reference text,
  description text,
  sort_order int not null default 0
);

create table if not exists public.readings (
  id bigint generated always as identity primary key,
  parameter text not null references public.standards(parameter) on update cascade on delete cascade,
  value numeric not null,
  source text not null check (source in ('sensor', 'lab', 'simulator')),
  status text not null check (status in ('pass', 'fail', 'monitor_only')),
  recorded_at timestamptz not null default now()
);

create table if not exists public.incidents (
  id bigint generated always as identity primary key,
  parameter text not null references public.standards(parameter) on update cascade on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  peak_value numeric not null,
  limits text not null,
  unit text
);

create table if not exists public.valve_events (
  id bigint generated always as identity primary key,
  state text not null check (state in ('open', 'locked')),
  reason text not null,
  source text not null check (source in ('device', 'simulator')),
  recorded_at timestamptz not null default now()
);

create or replace function public.fn_readings_before_insert()
returns trigger
security definer
set search_path = public
language plpgsql as $$
declare
  v_min numeric;
  v_max numeric;
begin
  select min_value, max_value into v_min, v_max
  from public.standards
  where parameter = NEW.parameter;

  if not found then
    raise exception 'Parameter % not found in standards', NEW.parameter;
  end if;

  if v_min is null and v_max is null then
    NEW.status := 'monitor_only';
  elsif v_min is not null and NEW.value < v_min then
    NEW.status := 'fail';
  elsif v_max is not null and NEW.value > v_max then
    NEW.status := 'fail';
  else
    NEW.status := 'pass';
  end if;

  if NEW.recorded_at is null then
    NEW.recorded_at := now();
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_readings_before_insert on public.readings;
create trigger trg_readings_before_insert
before insert on public.readings
for each row
execute function public.fn_readings_before_insert();

create or replace function public.fn_readings_after_insert()
returns trigger
security definer
set search_path = public
language plpgsql as $$
declare
  v_inc_id bigint;
  v_current_peak numeric;
  v_min numeric;
  v_max numeric;
  v_unit text;
  v_limit_str text;
begin
  select id, peak_value into v_inc_id, v_current_peak
  from public.incidents
  where parameter = NEW.parameter and closed_at is null
  order by opened_at desc
  limit 1;

  if NEW.status = 'fail' then
    if v_inc_id is null then
      select min_value, max_value, unit into v_min, v_max, v_unit
      from public.standards
      where parameter = NEW.parameter;

      if v_min is not null and v_max is not null then
        v_limit_str := v_min::text || ' - ' || v_max::text;
      elsif v_max is not null then
        v_limit_str := '<= ' || v_max::text;
      elsif v_min is not null then
        v_limit_str := '>= ' || v_min::text;
      else
        v_limit_str := 'Monitor';
      end if;

      insert into public.incidents (parameter, opened_at, peak_value, limits, unit)
      values (NEW.parameter, NEW.recorded_at, NEW.value, v_limit_str, v_unit);
    else
      select min_value, max_value into v_min, v_max
      from public.standards
      where parameter = NEW.parameter;

      if v_max is not null and NEW.value > v_current_peak then
        update public.incidents
        set peak_value = NEW.value
        where id = v_inc_id;
      elsif v_min is not null and v_max is null and NEW.value < v_current_peak then
        update public.incidents
        set peak_value = NEW.value
        where id = v_inc_id;
      end if;
    end if;
  elsif NEW.status = 'pass' then
    if v_inc_id is not null then
      update public.incidents
      set closed_at = NEW.recorded_at
      where id = v_inc_id;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_readings_after_insert on public.readings;
create trigger trg_readings_after_insert
after insert on public.readings
for each row
execute function public.fn_readings_after_insert();

create or replace view public.latest_readings
with (security_invoker = true) as
select distinct on (s.parameter)
  s.parameter,
  s.unit,
  s.min_value,
  s.max_value,
  s.mandatory,
  s.measurement,
  s.max_age_minutes,
  s.weight,
  s.reference,
  s.description,
  s.sort_order,
  r.id as reading_id,
  r.value,
  r.source,
  r.status,
  r.recorded_at,
  case
    when r.recorded_at is null then null
    else extract(epoch from (now() - r.recorded_at))::int
  end as age_seconds,
  case
    when r.recorded_at is null then true
    when now() - r.recorded_at > (s.max_age_minutes * interval '1 minute') then true
    else false
  end as is_stale
from public.standards s
left join public.readings r on s.parameter = r.parameter
order by s.parameter, r.recorded_at desc nulls last;

create or replace view public.assessment
with (security_invoker = true) as
with std_summary as (
  select count(*) as total_standards from public.standards
),
lr_stats as (
  select
    lr.parameter,
    lr.mandatory,
    lr.status,
    lr.is_stale,
    lr.recorded_at
  from public.latest_readings lr
),
missing_agg as (
  select
    coalesce(array_agg(parameter order by parameter), array[]::text[]) as missing_params
  from lr_stats
  where mandatory = true and (recorded_at is null or is_stale = true)
),
failing_agg as (
  select
    coalesce(array_agg(parameter order by parameter), array[]::text[]) as failing_params
  from lr_stats
  where status = 'fail'
)
select
  case
    when (select total_standards from std_summary) = 0 then 'unconfigured'
    when cardinality((select failing_params from failing_agg)) > 0 then 'not_pass'
    when cardinality((select missing_params from missing_agg)) > 0 then 'incomplete'
    else 'pass'
  end as overall,
  (select missing_params from missing_agg) as missing_parameters,
  (select failing_params from failing_agg) as failing_parameters,
  now() as calculated_at;

alter table public.settings enable row level security;
alter table public.standards enable row level security;
alter table public.readings enable row level security;
alter table public.incidents enable row level security;
alter table public.valve_events enable row level security;

drop policy if exists "settings_select" on public.settings;
create policy "settings_select" on public.settings
for select to public using (true);

drop policy if exists "settings_admin" on public.settings;
create policy "settings_admin" on public.settings
for all to authenticated using (true) with check (true);

drop policy if exists "standards_select" on public.standards;
create policy "standards_select" on public.standards
for select to public using (true);

drop policy if exists "standards_admin" on public.standards;
create policy "standards_admin" on public.standards
for all to authenticated using (true) with check (true);

drop policy if exists "readings_select" on public.readings;
create policy "readings_select" on public.readings
for select to public using (true);

drop policy if exists "readings_anon_insert" on public.readings;
create policy "readings_anon_insert" on public.readings
for insert to anon with check (source in ('sensor', 'simulator'));

drop policy if exists "readings_auth_all" on public.readings;
create policy "readings_auth_all" on public.readings
for all to authenticated using (true) with check (true);

drop policy if exists "incidents_select" on public.incidents;
create policy "incidents_select" on public.incidents
for select to public using (true);

drop policy if exists "incidents_admin" on public.incidents;
create policy "incidents_admin" on public.incidents
for all to authenticated using (true) with check (true);

drop policy if exists "valve_events_select" on public.valve_events;
create policy "valve_events_select" on public.valve_events
for select to public using (true);

drop policy if exists "valve_events_anon_insert" on public.valve_events;
create policy "valve_events_anon_insert" on public.valve_events
for insert to anon with check (source in ('device', 'simulator'));

drop policy if exists "valve_events_auth_all" on public.valve_events;
create policy "valve_events_auth_all" on public.valve_events
for all to authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert on table public.readings to anon;
grant insert on table public.valve_events to anon;
grant all on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'readings'
  ) then
    alter publication supabase_realtime add table public.readings;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'incidents'
  ) then
    alter publication supabase_realtime add table public.incidents;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'valve_events'
  ) then
    alter publication supabase_realtime add table public.valve_events;
  end if;
exception when others then
  null;
end $$;
