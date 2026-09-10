-- =============================================================================
-- 0031 · Platform owner PIN
--
-- A four-digit PIN that signs the platform owner in.
--
-- ## What this is, honestly
--
-- Four digits is 10,000 possibilities and carries no identity factor, and this account can
-- onboard, suspend and bill every customer on Carl. Hashing does not change that; only the
-- throttle below makes guessing impractical. It is implemented as strongly as a PIN can be
-- implemented, and the residual risk is a product decision recorded in
-- docs/verification/PLATFORM_OWNER_PIN.md.
--
-- What this design does guarantee:
--
--   * The PIN is never stored in plaintext, anywhere. Only a bcrypt hash.
--   * The PIN never reaches browser JavaScript, localStorage, or a NEXT_PUBLIC_ variable.
--   * Verification happens only in the database, called only by the server.
--   * Guessing is throttled globally, so an attacker cannot spread attempts across accounts.
--   * A correct PIN yields an ordinary Supabase session for a real platform_admins user —
--     it does not bypass RLS, and every existing authorization check still applies.
-- =============================================================================

alter table platform_admins
  add column if not exists pin_hash       text,
  add column if not exists pin_set_at     timestamptz,
  add column if not exists pin_is_default boolean not null default false,
  add column if not exists last_login_at  timestamptz;

comment on column platform_admins.pin_hash is
  'bcrypt hash of the owner PIN. Never plaintext, never sent to a client.';
comment on column platform_admins.pin_is_default is
  'True while the seeded default is still in use, so the console can insist it be changed.';

-- -----------------------------------------------------------------------------
-- The throttle
--
-- Deliberately global rather than per-admin. A per-account counter lets an attacker work
-- through the keyspace by rotating which account they guess against; with one owner that
-- is moot, but the table is what makes it moot on purpose rather than by accident.
--
-- It also means a determined attacker can lock the owner out — a denial of service. That
-- is the correct trade for an account of this privilege: a locked-out owner waits, whereas
-- a guessed PIN loses every customer's data.
-- -----------------------------------------------------------------------------
create table platform_pin_throttle (
  id                 boolean primary key default true,
  consecutive_failures integer not null default 0,
  locked_until       timestamptz,
  last_attempt_at    timestamptz,
  constraint platform_pin_throttle_singleton check (id)
);

insert into platform_pin_throttle (id) values (true) on conflict do nothing;

alter table platform_pin_throttle enable row level security;
alter table platform_pin_throttle force row level security;

/*
 * An explicit refusal, rather than no policy at all.
 *
 * The effect is identical — RLS with no policy denies everyone — but the intent is not.
 * A table with no policy reads as an oversight, and the RLS coverage gate treats it as one,
 * correctly: nobody looking at this later can tell whether the author meant it. Saying
 * `false` says it.
 *
 * The functions in this migration are SECURITY DEFINER and owned by the schema owner, so
 * they bypass RLS and are the only route to this table.
 */
create policy platform_pin_throttle_no_direct_access on platform_pin_throttle
  for all to authenticated, anon
  using (false)
  with check (false);

comment on table platform_pin_throttle is
  'Brute-force throttle for the owner PIN. Reachable only through verify_platform_pin.';

-- -----------------------------------------------------------------------------
-- app.verify_platform_pin
--
-- Called by the server before any session exists, so it cannot rely on auth.uid(). It is
-- therefore executable only by service_role — never by anon or authenticated, which would
-- turn it into a public brute-force oracle.
-- -----------------------------------------------------------------------------
-- In `public` rather than `app` so the server can reach it through PostgREST, which only
-- exposes `public`. That is safe precisely because EXECUTE is granted to service_role and
-- to nobody else: PostgREST enforces the grant, so an anonymous or merchant caller is
-- refused before the function runs. Without that grant this would be a public
-- brute-force oracle.
create or replace function verify_platform_pin(p_pin text)
returns table (status text, user_id uuid, email text, is_default boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_throttle record;
  v_admin    record;
  v_delay    interval;
  v_failures integer;
begin
  /*
   * This function RETURNS a status and never raises on a bad PIN. That is load-bearing.
   *
   * `raise exception` aborts the transaction, which would roll back the very UPDATE that
   * records the failed attempt. Written that way the counter could never increment: the
   * throttle looked present, every call behaved plausibly, and each wrong guess was free.
   * Returning a status lets the increment commit, which is the only reason the lockout
   * works at all.
   */
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return query select 'INVALID'::text, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- Created if missing, then locked. Without the insert a restore or stray DELETE would
  -- leave the UPDATE below matching nothing, silently removing brute-force protection.
  insert into public.platform_pin_throttle (id) values (true) on conflict (id) do nothing;
  select * into v_throttle from public.platform_pin_throttle where id limit 1 for update;

  if v_throttle.locked_until is not null and v_throttle.locked_until > now() then
    -- The remaining time is not disclosed: it tells an attacker how the backoff is shaped
    -- and exactly how long to sleep between batches.
    return query select 'LOCKED'::text, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- Checked against every administrator holding a PIN. There is realistically one, and
  -- iterating keeps a second owner from being locked out of their own console.
  for v_admin in
    select pa.user_id as uid, p.email::text as mail, pa.pin_hash as hash, pa.pin_is_default as dflt
    from public.platform_admins pa
    join public.profiles p on p.id = pa.user_id
    where pa.pin_hash is not null
  loop
    if v_admin.hash = extensions.crypt(p_pin, v_admin.hash) then
      update public.platform_pin_throttle
         set consecutive_failures = 0, locked_until = null, last_attempt_at = now()
       where id;
      update public.platform_admins pa
         set last_login_at = now()
       where pa.user_id = v_admin.uid;

      return query select 'OK'::text, v_admin.uid, v_admin.mail, v_admin.dflt;
      return;
    end if;
  end loop;

  /*
   * Wrong. Backoff grows with consecutive failures: nothing for the first three, then
   * seconds, then minutes, then a quarter of an hour. Ten thousand possibilities at
   * fifteen minutes a throw is not an attack anybody finishes.
   */
  v_failures := coalesce(v_throttle.consecutive_failures, 0) + 1;
  v_delay := case
    when v_failures < 3  then null
    when v_failures < 5  then interval '30 seconds'
    when v_failures < 8  then interval '2 minutes'
    when v_failures < 12 then interval '5 minutes'
    else interval '15 minutes'
  end;

  update public.platform_pin_throttle
     set consecutive_failures = v_failures,
         last_attempt_at = now(),
         locked_until = case when v_delay is null then null else now() + v_delay end
   where id;

  -- The same answer whether or not a PIN is configured, so the response cannot be used to
  -- discover whether the console has been set up.
  return query select 'INVALID'::text, null::uuid, null::text, null::boolean;
end;
$$;

revoke execute on function verify_platform_pin(text) from public, anon, authenticated;
grant execute on function verify_platform_pin(text) to service_role;

comment on function verify_platform_pin(text) is
  'Verifies the owner PIN and records the attempt. Returns a status; never raises on a bad PIN, because raising would roll back the failed-attempt counter. service_role only.';

-- -----------------------------------------------------------------------------
-- change_platform_pin
--
-- Runs as the signed-in owner, so it can use auth.uid(). Verifying the current PIN is not
-- ceremony: without it, anyone who reaches an unlocked, signed-in console can silently
-- change the credential and keep the owner out of their own platform.
-- -----------------------------------------------------------------------------
create or replace function change_platform_pin(p_current_pin text, p_new_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may change the owner PIN.';
  end if;
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4}$' then
    raise exception 'VALIDATION_FAILED' using detail = 'A PIN is four digits.';
  end if;
  if p_new_pin = '1024' then
    raise exception 'VALIDATION_FAILED'
      using detail = 'That is the published default. Choose a different PIN.';
  end if;
  -- Four identical digits and simple runs are the first thing anybody tries.
  if p_new_pin ~ '^(.)\1{3}$' or p_new_pin in ('1234','4321','0123','9876') then
    raise exception 'VALIDATION_FAILED' using detail = 'That PIN is too easy to guess.';
  end if;

  select pa.pin_hash into v_hash
  from public.platform_admins pa
  where pa.user_id = auth.uid();

  if v_hash is null then
    raise exception 'VALIDATION_FAILED' using detail = 'No PIN is set for this account.';
  end if;
  if v_hash <> extensions.crypt(coalesce(p_current_pin, ''), v_hash) then
    raise exception 'INVALID_PIN' using detail = 'The current PIN is not correct.';
  end if;

  update public.platform_admins
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 12)),
         pin_set_at = now(),
         pin_is_default = false
   where public.platform_admins.user_id = auth.uid();

  -- Audited, without the PIN. Recording either the old or the new value — even hashed —
  -- would put the credential in a table many people can read.
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'PLATFORM_PIN_CHANGED', 'platform_admin', auth.uid(),
          jsonb_build_object('changed_at', now()));
end;
$$;

revoke execute on function change_platform_pin(text, text) from public, anon;
grant execute on function change_platform_pin(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Seed the documented default for any administrator without a PIN.
--
-- The hash is computed here rather than written literally, so the repository never carries
-- a credential — but `1024` is published in the specification, so `pin_is_default` stays
-- true and the console insists on a change.
-- -----------------------------------------------------------------------------
update platform_admins
   set pin_hash = extensions.crypt('1024', extensions.gen_salt('bf', 12)),
       pin_set_at = now(),
       pin_is_default = true
 where pin_hash is null;

comment on function change_platform_pin(text, text) is
  'Changes the owner PIN. Requires the current PIN. Never logs either value.';
