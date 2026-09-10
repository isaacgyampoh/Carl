-- =============================================================================
-- 0033 · Signing in at a till
--
-- A cashier standing at a Windows POS types four digits and nothing else.
--
-- ## Why this function exists at all
--
-- The desktop terminal asked for an email and a password. Carl's staff have neither: they
-- are issued PINs. So the one client that actually sells things was the one client nobody
-- could log into. This does not change the authentication model — it makes the existing
-- model reachable from the till.
--
-- ## Why the till does not send a shop name
--
-- It already knows which shop it is. `activate_device` bound it to a tenant and a branch,
-- and that binding is proven by the device secret. Asking a cashier to also identify their
-- employer would be a question the hardware can already answer, and a field to mistype
-- during a queue.
--
-- ## The order of the two checks is load-bearing
--
-- The device is authorised FIRST. Without that, this function is a public oracle: anyone
-- who can reach the endpoint could guess PINs against any tenant they can name. Requiring
-- a valid device secret means an attacker must already possess a provisioned terminal, and
-- the per-tenant throttle then applies on top.
-- =============================================================================

create or replace function verify_device_staff_pin(
  p_device_id     uuid,
  p_device_secret text,
  p_pepper        text,
  p_pin           text
)
returns table (
  out_status  text,
  out_email   text,
  out_user_id uuid,
  out_must_change boolean,
  out_tenant_name text,
  out_branch_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device record;
  v_slug   text;
  v_pin    record;
begin
  -- Raises on a bad or revoked device. A till that is not itself trusted never reaches the
  -- PIN check, so this cannot be used to brute-force a shop from outside.
  perform app.authorize_device(p_device_id, p_device_secret, p_pepper);

  select d.tenant_id, d.branch_id, t.slug, t.name as tenant_name, b.name as branch_name
    into v_device
  from public.devices d
  join public.tenants t on t.id = d.tenant_id
  join public.branches b on b.id = d.branch_id
  where d.id = p_device_id;

  if not found then
    raise exception 'NOT_FOUND' using detail = 'That terminal is not registered.';
  end if;

  v_slug := v_device.slug;

  -- Reuses the same verification the web uses, so a cashier's PIN behaves identically
  -- whichever client they stand in front of — including the per-tenant throttle, the
  -- suspended-business refusal, and the must-change flag on an issued PIN.
  select vm.out_status, vm.out_email, vm.out_user_id, vm.out_must_change
    into v_pin
  from public.verify_member_pin(v_slug, p_pin) vm;

  return query
    select v_pin.out_status, v_pin.out_email, v_pin.out_user_id, v_pin.out_must_change,
           v_device.tenant_name::text, v_device.branch_name::text;
end;
$$;

revoke execute on function verify_device_staff_pin(uuid, text, text, text) from public, anon, authenticated;
grant execute on function verify_device_staff_pin(uuid, text, text, text) to service_role;

comment on function verify_device_staff_pin(uuid, text, text, text) is
  'Signs a cashier in at an activated till: device secret first, then their PIN. service_role only.';
