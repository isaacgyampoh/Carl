-- =============================================================================
-- 0035 · The owner PIN must exist for administrators created after 0031
--
-- ## The defect
--
-- Migration 0031 seeds the documented default PIN like this:
--
--     update platform_admins
--        set pin_hash = extensions.crypt('1024', ...), pin_is_default = true
--      where pin_hash is null;
--
-- That is a one-time statement. It applies to rows that exist at the moment the migration
-- runs, and to nothing afterwards.
--
-- The documented way to create the first platform administrator (docs/DEPLOYMENT.md, "Create
-- the first platform administrator") is to insert the row AFTER the schema is deployed:
--
--     insert into platform_admins (user_id, note) values (...);
--
-- `pin_hash` is nullable with no default, so that row gets NULL. And `verify_platform_pin`
-- only considers administrators who have a hash:
--
--     where pa.pin_hash is not null
--
-- With no candidate rows the loop never runs and the function returns INVALID — for every
-- PIN, including the correct one. The owner is told "That PIN is not correct", which is
-- true of nothing: there is no PIN to be correct about.
--
-- Observed on the live database before this migration: two administrators, zero with a
-- pin_hash, pin_is_default false on both — the column default rather than the seeded value,
-- which is the fingerprint of a row that 0031's UPDATE never saw.
--
-- ## The fix
--
-- Seed at INSERT rather than once at migration time, so the documented deployment step
-- produces a working administrator. The repair below then covers rows already created.
--
-- ## What this deliberately does not change
--
--   * The PIN is still never stored in plaintext and never written literally in this
--     repository — the hash is computed by the database at runtime, as 0031 does.
--   * `pin_is_default` is set to TRUE, so sign-in routes the owner straight to
--     /platform/settings?change_pin=1 and the console insists on a change.
--   * verify_platform_pin, its throttle, its grants and its search_path are untouched.
--   * Nothing here makes a wrong PIN succeed.
--
-- The exposure this leaves is the one the design already accepted and documented: a newly
-- created administrator holds a published default until they change it. The alternative
-- currently in production is an administrator who cannot sign in at all, which is not more
-- secure — an account with no usable credential is not protected, it is broken.
-- =============================================================================

create or replace function app.platform_admin_default_pin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  /*
   * Only when no PIN was supplied. An administrator inserted with a hash already chosen
   * keeps it, and this must never overwrite a real credential with the published default.
   */
  if new.pin_hash is null then
    new.pin_hash := extensions.crypt('1024', extensions.gen_salt('bf', 12));
    new.pin_set_at := now();
    new.pin_is_default := true;
  end if;
  return new;
end;
$$;

comment on function app.platform_admin_default_pin() is
  'Gives a new platform administrator the documented default PIN, flagged as default so the console demands a change. Without it, an administrator created after migration 0031 has no PIN and can never sign in.';

drop trigger if exists platform_admins_default_pin on platform_admins;

create trigger platform_admins_default_pin
  before insert on platform_admins
  for each row
  execute function app.platform_admin_default_pin();

-- -----------------------------------------------------------------------------
-- Repair the administrators that already exist without a PIN.
--
-- Idempotent, and narrowed to exactly the broken state: a NULL hash. It cannot touch an
-- administrator who has set their own PIN, and it changes nothing else about the row — not
-- the grant, not the note, not who granted it.
-- -----------------------------------------------------------------------------
update platform_admins
   set pin_hash = extensions.crypt('1024', extensions.gen_salt('bf', 12)),
       pin_set_at = now(),
       pin_is_default = true
 where pin_hash is null;
