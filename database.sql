BEGIN;

-- Family Blood Pressure Log: Supabase database setup.
-- Open a fresh SQL Editor query. Paste and execute the entire file.
-- Run as a single query, without highlighting only part of the script.
-- This is re-runnable; it does not delete existing measurements.

create extension if not exists pgcrypto;

create table if not exists public.bp_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 30),
  takes_medicine boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.bp_measurements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  member_id uuid not null references public.bp_members(id) on delete restrict,
  measured_on date not null,
  measured_time time without time zone not null,
  systolic integer not null check (systolic > 0 and systolic <= 500),
  diastolic integer not null check (diastolic > 0 and diastolic <= 500),
  pulse integer not null check (pulse > 0 and pulse <= 500),
  medication_status text not null default 'unknown'
    check (medication_status in ('no','before','after','missed','unknown')),
  note text not null default '' check (length(note) <= 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.bp_sync_checks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now()
);

create index if not exists bp_members_owner_id_idx on public.bp_members(owner_id);
create index if not exists bp_measurements_member_time_idx
  on public.bp_measurements(member_id,measured_on desc,measured_time desc);
create index if not exists bp_measurements_owner_id_idx on public.bp_measurements(owner_id);
create index if not exists bp_sync_checks_owner_created_idx
  on public.bp_sync_checks(owner_id,created_at desc);

alter table public.bp_members enable row level security;
alter table public.bp_measurements enable row level security;
alter table public.bp_sync_checks enable row level security;

-- An API publishable key is not a user login; the anon role has no table access.
revoke all on table public.bp_members, public.bp_measurements, public.bp_sync_checks from anon;
revoke all on table public.bp_members, public.bp_measurements, public.bp_sync_checks from authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.bp_members, public.bp_measurements, public.bp_sync_checks to authenticated;

-- A signed-in family account may access only its own member profiles.
drop policy if exists "family bp_members read" on public.bp_members;
create policy "family bp_members read" on public.bp_members for select to authenticated
  using (owner_id = (select auth.uid()));
drop policy if exists "family bp_members create" on public.bp_members;
create policy "family bp_members create" on public.bp_members for insert to authenticated
  with check (owner_id = (select auth.uid()));
drop policy if exists "family bp_members edit" on public.bp_members;
create policy "family bp_members edit" on public.bp_members for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "family bp_members delete" on public.bp_members;
create policy "family bp_members delete" on public.bp_members for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Measurement access requires ownership of both the row and linked member.
drop policy if exists "family bp_measurements read" on public.bp_measurements;
create policy "family bp_measurements read" on public.bp_measurements for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.bp_members m where m.id = member_id and m.owner_id = (select auth.uid())
  ));
drop policy if exists "family bp_measurements create" on public.bp_measurements;
create policy "family bp_measurements create" on public.bp_measurements for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists (
    select 1 from public.bp_members m where m.id = member_id and m.owner_id = (select auth.uid())
  ));
drop policy if exists "family bp_measurements edit" on public.bp_measurements;
create policy "family bp_measurements edit" on public.bp_measurements for update to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.bp_members m where m.id = member_id and m.owner_id = (select auth.uid())
  ))
  with check (owner_id = (select auth.uid()) and exists (
    select 1 from public.bp_members m where m.id = member_id and m.owner_id = (select auth.uid())
  ));
drop policy if exists "family bp_measurements delete" on public.bp_measurements;
create policy "family bp_measurements delete" on public.bp_measurements for delete to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.bp_members m where m.id = member_id and m.owner_id = (select auth.uid())
  ));

-- Cross-device diagnostic codes are stored separately from measurements.
drop policy if exists "family checks read" on public.bp_sync_checks;
create policy "family checks read" on public.bp_sync_checks for select to authenticated
  using (owner_id = (select auth.uid()));
drop policy if exists "family checks create" on public.bp_sync_checks;
create policy "family checks create" on public.bp_sync_checks for insert to authenticated
  with check (owner_id = (select auth.uid()));
drop policy if exists "family checks delete" on public.bp_sync_checks;
create policy "family checks delete" on public.bp_sync_checks for delete to authenticated
  using (owner_id = (select auth.uid()));

COMMIT;

-- Expected result: three TRUE columns. This only checks for table existence.
-- Authenticate, write, read, and compare two devices to test actual sync.
SELECT
  to_regclass('public.bp_members') IS NOT NULL AS members_ready,
  to_regclass('public.bp_measurements') IS NOT NULL AS measurements_ready,
  to_regclass('public.bp_sync_checks') IS NOT NULL AS sync_checks_ready;
