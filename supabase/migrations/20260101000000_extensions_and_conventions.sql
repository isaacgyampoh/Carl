-- =============================================================================
-- 0000 · Extensions, schemas and shared conventions
--
-- Establishes the scaffolding every later migration depends on:
--   * the `extensions` schema Supabase resolves extensions from
--   * the `app` schema, which holds Carl's internal helper functions
--   * shared domains and triggers used across the schema
--
-- ## Why `app` is a separate schema
--
-- The functions RLS policies call must be reachable by the planner but must NOT be
-- callable directly over the REST API. `app` is deliberately absent from the exposed
-- schema list in config.toml, so a client cannot invoke, inspect or probe them.
-- =============================================================================

create schema if not exists extensions;
create schema if not exists app;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

-- Inside a function with `set search_path = ''`, EVERY identifier must be schema-qualified
-- -- including enum types in casts (`'RECEIVED'::public.purchase_status`). An unqualified
-- cast fails at runtime with "type does not exist", and only when that branch executes.
--
-- Extension objects are ALWAYS referenced schema-qualified (extensions.citext,
-- extensions.digest, ...). The `extensions` schema is on the search_path for Supabase's
-- API roles but not during migration execution, so an unqualified reference applies
-- inconsistently - and fails on a clean database while appearing to work on a developer's.
comment on schema app is
  'Carl internal helpers. Not exposed over the API; called by RLS policies and SECURITY DEFINER functions.';

-- The API roles may execute helpers (RLS policies run as the caller and must be able to
-- evaluate them) but may not create anything here.
grant usage on schema app to authenticated, service_role;
grant usage on schema extensions to authenticated, anon, service_role;
revoke create on schema public from public;


-- =============================================================================
-- Shared domains
--
-- A domain applies its CHECK to every column that uses it, so the rule cannot be
-- forgotten on the twentieth table that stores an amount.
-- =============================================================================

-- Money, as an integer count of minor units (pesewas). Never a float, never numeric.
-- See packages/shared/src/money.ts for the reasoning.
create domain app.money_minor as bigint
  constraint money_minor_within_range check (value >= -1000000000000 and value <= 1000000000000);

comment on domain app.money_minor is
  'Monetary amount in minor units (pesewas). Integer arithmetic only; see @carl/shared money.ts.';

-- Quantity to three decimal places, matching @carl/shared quantity.ts.
create domain app.quantity as numeric(14, 3);

comment on domain app.quantity is
  'Quantity to 3 decimal places. Products may be sold by weight, so this is not an integer.';

-- A percentage from 0 to 100 with two decimals.
create domain app.percentage as numeric(5, 2)
  constraint percentage_within_range check (value >= 0 and value <= 100);

-- Trimmed, non-empty text. Prevents the '   ' that passes a NOT NULL check but is not a name.
create domain app.label as text
  constraint label_not_blank check (length(btrim(value)) > 0)
  constraint label_length check (length(value) <= 200);

-- A short machine-readable key: lowercase, no spaces.
create domain app.slug as text
  constraint slug_format check (value ~ '^[a-z0-9][a-z0-9_-]{0,62}$');


-- =============================================================================
-- Shared triggers
-- =============================================================================

-- Maintains updated_at. Done in the database rather than the application because a row
-- can be changed by a migration, a support script or psql, and the timestamp must still
-- be right.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at() is
  'BEFORE UPDATE trigger maintaining updated_at regardless of who performs the write.';

-- Refuses any UPDATE or DELETE. Applied to the audit log, whose value depends entirely
-- on it being unalterable - including by a tenant admin covering their tracks.
create or replace function app.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'IMMUTABLE_RECORD'
    using
      detail = format('%I.%I is append-only; %s is not permitted.', tg_table_schema, tg_table_name, tg_op),
      hint = 'Insert a compensating record instead of altering history.';
end;
$$;

comment on function app.reject_mutation() is
  'Trigger that refuses UPDATE/DELETE, making a table append-only.';
