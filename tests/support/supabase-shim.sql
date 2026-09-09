-- =============================================================================
-- Supabase compatibility shim for the local test harness.
--
-- Carl's migrations target a hosted Supabase project, where the `auth` schema, the
-- `anon` / `authenticated` / `service_role` database roles, and `auth.uid()` already
-- exist. A bare PostgreSQL instance has none of them, so migrations would fail to apply
-- and — far worse — RLS policies referencing `auth.uid()` could not be exercised at all.
--
-- This file recreates those objects with the same semantics Supabase gives them, so the
-- test suite runs the *real* policies against a *real* PostgreSQL planner.
--
-- It is applied ONLY by the test harness. It is not a migration and never reaches a
-- deployed database. On hosted Supabase every statement here is either already true or
-- guarded by IF NOT EXISTS.
-- =============================================================================

-- Supabase resolves extensions from a dedicated schema rather than public.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

-- Supabase's PostgREST roles.
--   anon           — unauthenticated request
--   authenticated  — a signed-in end user; every RLS policy is written against this role
--   service_role   — trusted server-side operations; bypasses RLS by design
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

-- Supabase's own users table. Carl never writes to it directly; `public.profiles` mirrors
-- the subset Carl needs and is what every foreign key points at.
-- NOTE: `id` deliberately has NO default, matching real Supabase, where GoTrue supplies
-- it. An earlier version of this shim defaulted to gen_random_uuid(); fixtures then relied
-- on that and worked locally while failing against a real project. A shim that is more
-- permissive than production hides exactly the bugs it exists to catch.
create table if not exists auth.users (
  id            uuid primary key,
  email         text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- The identity functions every RLS policy is built on. These mirror Supabase's
-- implementations exactly: the JWT claims are injected by PostgREST as the
-- `request.jwt.claims` GUC, and the helpers read `sub` and `role` out of it.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  )
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.email', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    ),
    ''
  )
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
-- Grants on auth.users deliberately mirror a real Supabase project, where the table is
-- owned by `supabase_auth_admin` and accounts are created through the Auth admin API:
--
--   authenticated  SELECT only
--   service_role   NOTHING — it has no privileges on auth.users at all
--
-- An earlier version granted service_role full access "so fixtures could create users".
-- Fixtures then did exactly that, which worked locally and failed on forty tests against a
-- real project with "permission denied for table users". The harness now creates accounts
-- through `asAdmin`, which runs as the connection owner — the closest local equivalent of
-- the Auth admin API.
grant select on auth.users to authenticated;

-- Supabase grants the API roles usage on public and default privileges on new objects.
-- Without this, a table created by a migration would be unreadable by `authenticated` for
-- reasons unrelated to RLS, and an RLS test would pass for the wrong reason.
--
-- Note that `anon` is included. That is what a real Supabase project does, and an earlier
-- version of this shim omitted it — which made the "anon holds no table privileges"
-- assertion pass locally while failing against production, where `anon` held 364 grants.
-- A shim more restrictive than production hides exactly the findings it exists to surface,
-- so it now grants what Supabase grants and lets migration 0025 take them away.
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete, truncate, references, trigger on tables
  to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;


-- =============================================================================
-- Test-only reset helper.
--
-- `reset()` runs before every test, and truncating all ~50 tables each time is the
-- single most repeated operation in the suite. Most tests touch five or six of them, so
-- this checks which are actually populated and truncates only those.
--
-- The emptiness check is a `limit 1` against a table that is nearly always empty, which
-- costs almost nothing; the TRUNCATE it avoids does not.
--
-- Seeded reference data (permissions, role templates, plans) is preserved: wiping it
-- leaves provision_tenant() with no roles to copy, which surfaces later as a baffling
-- CROSS_TENANT_REFERENCE from an integrity trigger.
-- =============================================================================

create or replace function public.carl_test_reset(p_preserve text[])
returns void
language plpgsql
as $$
declare
  r         record;
  populated text[] := array[]::text[];
  has_rows  boolean;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname <> all(p_preserve)
    order by c.relname
  loop
    execute format('select exists (select 1 from public.%I limit 1)', r.relname) into has_rows;
    if has_rows then
      populated := populated || format('public.%I', r.relname);
    end if;
  end loop;

  if array_length(populated, 1) > 0 then
    execute 'truncate table ' || array_to_string(populated, ', ') || ' restart identity cascade';
  end if;

  if exists (select 1 from auth.users limit 1) then
    truncate table auth.users cascade;
  end if;
end;
$$;
