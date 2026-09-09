-- =============================================================================
-- 0025 · Remove the `anon` role's table privileges
--
-- ## What this fixes
--
-- Supabase grants `anon`, `authenticated` and `service_role` full privileges on every
-- table created in `public`, via ALTER DEFAULT PRIVILEGES applied to the schema. On a
-- deployed Carl project that meant `anon` held SELECT, INSERT, UPDATE, DELETE and TRUNCATE
-- on all fifty tables — 364 grants in total.
--
-- ## Was it exploitable?
--
-- No. Row Level Security is enabled and forced on every table, and no policy admits
-- `anon`, so every one of those grants resolves to zero rows or a refusal.
--
-- ## Then why change it?
--
-- Because the protection was one layer thick instead of two, and the remaining layer is
-- the one most likely to be weakened by an ordinary, well-intentioned change. The moment
-- anyone adds a permissive policy to a lookup table — `for select using (true)`, which is
-- a perfectly reasonable thing to write for a list of countries — `anon` would gain not
-- just read access but INSERT, UPDATE and DELETE, because the grant was already sitting
-- there.
--
-- Carl has no unauthenticated data surface at all. `anon` exists only to carry a request
-- as far as the sign-in endpoint. It should therefore hold nothing.
--
-- ## How this was found
--
-- Not by review. The `rls-coverage` suite asserts that `anon` holds no table privileges;
-- it passed against the in-process test harness, whose Supabase shim never granted them,
-- and failed the first time the identical suite was run against a real Supabase project.
-- The shim has been corrected to match production so the local run cannot pass for this
-- reason again.
-- =============================================================================

revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke all privileges on all functions in schema public from anon;

-- Future tables must not re-acquire them. Supabase's own default privileges are applied
-- as the `postgres` role, so the matching FOR ROLE is required to undo them.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- `anon` keeps USAGE on the schema. Without it PostgREST cannot resolve a request at all,
-- and an unauthenticated caller would receive a schema error rather than a clean 401.
grant usage on schema public to anon;

-- The API roles that genuinely need access keep it. RLS remains what decides which rows
-- they actually see.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
