-- =============================================================================
-- 0030 · Platform operations
--
-- The transactional operations the platform owner performs on a customer account:
-- onboarding, billing, collecting, suspending, reinstating.
--
-- ## Why these are database functions
--
-- Each one touches several tables and must not half-happen. A tenant without its branch,
-- a subscription pointing at no tenant, a payment recorded against an invoice that was
-- never marked paid — every one of those is a support call, and some are an argument with
-- a customer about money.
--
-- ## The shape every function here follows
--
--   1. Authorise: `app.is_platform_admin()`, checked here and not taken on trust from an
--      application that might have forgotten.
--   2. Validate the input.
--   3. Do the work atomically.
--   4. Write an audit entry.
--   5. Return only what the caller needs.
--
-- SECURITY DEFINER throughout, because these deliberately write tables whose RLS policies
-- grant no direct write access to anyone. That is the point: the only way to change a
-- customer's commercial state is through a function that checks, enforces and records.
-- Every one pins `search_path`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- onboard_client
--
-- Composes around `provision_tenant` rather than duplicating it. That function already
-- creates the tenant, its first branch, the owner's profile and membership, the system
-- roles and their permissions, and the branch cash register — correctly, and tested. What
-- it does not do is record the commercial relationship, which is what this adds.
-- -----------------------------------------------------------------------------
create or replace function onboard_client(
  p_business_name   text,
  p_slug            text,
  p_owner_email     text,
  p_owner_name      text,
  p_owner_user_id   uuid,
  p_plan_id         uuid,
  p_branch_name     text default 'Main Branch',
  p_branch_code     text default 'main',
  p_contact_person  text default null,
  p_email           text default null,
  p_phone           text default null,
  p_address         text default null,
  p_legal_name      text default null,
  p_country_code    char(2) default 'GH',
  p_currency_code   char(3) default 'GHS',
  p_timezone        text default 'Africa/Accra',
  p_trial_days      integer default 14,
  p_price           bigint default null,
  p_interval        billing_interval default null,
  p_grace_days      smallint default 7,
  p_starts_at       timestamptz default null,
  p_notes           text default null
)
returns table (
  tenant_id       uuid,
  branch_id       uuid,
  membership_id   uuid,
  subscription_id uuid,
  status          tenant_status,
  next_billing_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan      record;
  v_prov      record;
  v_sub_id    uuid;
  v_status    public.tenant_status;
  v_starts    timestamptz;
  v_period_end timestamptz;
  v_price     bigint;
  v_interval  public.billing_interval;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may onboard a client.';
  end if;

  if coalesce(trim(p_business_name), '') = '' then
    raise exception 'VALIDATION_FAILED' using detail = 'A business name is required.';
  end if;
  if p_owner_user_id is null then
    raise exception 'VALIDATION_FAILED' using detail = 'An owner account is required.';
  end if;
  if p_trial_days < 0 or p_trial_days > 365 then
    raise exception 'VALIDATION_FAILED' using detail = 'A trial must be between 0 and 365 days.';
  end if;
  if p_grace_days < 0 or p_grace_days > 90 then
    raise exception 'VALIDATION_FAILED' using detail = 'A grace period must be 0 to 90 days.';
  end if;

  select * into v_plan from public.subscription_plans sp where sp.id = p_plan_id and sp.is_active;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That subscription plan does not exist or is not active.';
  end if;

  -- The plan is the source of price and interval. An override is permitted — a negotiated
  -- rate is an ordinary commercial fact — but it is never taken from the browser silently:
  -- it arrives as an explicit argument and is recorded on the subscription.
  v_price    := coalesce(p_price, v_plan.price);
  v_interval := coalesce(p_interval, v_plan.interval);
  if v_price < 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'A price cannot be negative.';
  end if;

  v_starts := coalesce(p_starts_at, now());
  v_status := case when p_trial_days > 0 then 'TRIAL' else 'ACTIVE' end;

  -- Tenant, branch, owner membership, roles, permissions, cash register — all of it.
  select * into v_prov from public.provision_tenant(
    p_slug, p_business_name, p_owner_email, p_owner_name, p_owner_user_id,
    p_branch_name, p_branch_code, v_status, p_trial_days
  );

  -- The commercial detail `provision_tenant` has no opinion about.
  --
  -- The tenant's email is the business's billing contact, which is not necessarily the
  -- owner's login address — a shop often wants invoices going to an accounts inbox. It
  -- defaults to the owner's address because that is the one detail always known.
  update public.tenants
     set legal_name     = coalesce(p_legal_name, legal_name),
         contact_person = coalesce(p_contact_person, contact_person),
         email          = coalesce(p_email, p_owner_email)::extensions.citext,
         phone          = coalesce(p_phone, phone),
         address        = coalesce(p_address, address),
         country_code   = coalesce(p_country_code, country_code),
         currency_code  = coalesce(p_currency_code, currency_code),
         timezone       = coalesce(p_timezone, timezone)
   where id = v_prov.tenant_id;

  v_period_end := v_starts + case v_interval
                    when 'MONTHLY'   then interval '1 month'
                    when 'QUARTERLY' then interval '3 months'
                    when 'ANNUAL'    then interval '1 year'
                  end;

  insert into public.subscriptions
    (tenant_id, plan_id, status, price, currency_code, interval,
     current_period_start, current_period_end, grace_days, trial_ends_at, notes, created_by)
  values (
    v_prov.tenant_id, p_plan_id,
    -- Explicitly cast: a bare CASE yields text, and the column is subscription_status.
    (case when p_trial_days > 0 then 'TRIALING' else 'ACTIVE' end)::public.subscription_status,
    v_price, coalesce(p_currency_code, v_plan.currency_code), v_interval,
    v_starts, v_period_end, p_grace_days,
    case when p_trial_days > 0 then v_starts + make_interval(days => p_trial_days) end,
    p_notes, auth.uid()
  )
  returning id into v_sub_id;

  insert into public.audit_logs
    (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_prov.tenant_id, auth.uid(), 'CLIENT_ONBOARDED', 'tenant', v_prov.tenant_id,
    jsonb_build_object(
      'business_name', p_business_name,
      'plan', v_plan.key,
      'price', v_price,
      'interval', v_interval,
      'trial_days', p_trial_days,
      'subscription_id', v_sub_id
    )
  );

  return query
    select v_prov.tenant_id, v_prov.branch_id, v_prov.membership_id, v_sub_id,
           v_status, v_period_end;
end;
$$;

revoke execute on function onboard_client from public, anon;
grant execute on function onboard_client to authenticated;

comment on function onboard_client is
  'Creates a customer: tenant, branch, owner, roles and subscription, atomically. Platform administrators only.';

-- -----------------------------------------------------------------------------
-- record_subscription_payment
--
-- A merchant has paid — in cash, by mobile money, by transfer — and the platform owner is
-- writing it down. There is no payment gateway here and none is wanted; this records a
-- payment that already happened in the real world.
--
-- ## Idempotency
--
-- The platform owner is a person with a phone on a bad connection. If they press "record
-- payment" twice, or a request times out and they retry, a merchant must not end up with
-- two payments and two months of credit. The idempotency key makes the retry return the
-- original payment instead of creating a second one.
-- -----------------------------------------------------------------------------
create or replace function record_subscription_payment(
  p_subscription_id uuid,
  p_amount          bigint,
  p_idempotency_key text,
  p_method          payment_method default 'BANK_TRANSFER',
  p_reference       text default null,
  p_paid_at         timestamptz default null,
  p_period_start    timestamptz default null,
  p_period_end      timestamptz default null,
  p_invoice_id      uuid default null,
  p_notes           text default null
)
returns table (
  payment_id      uuid,
  subscription_status subscription_status,
  period_end      timestamptz,
  was_replayed    boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub        record;
  v_existing   record;
  v_payment_id uuid;
  v_paid_at    timestamptz;
  v_start      timestamptz;
  v_end        timestamptz;
  v_new_status public.subscription_status;
  v_fingerprint text;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may record a subscription payment.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'A payment must be a positive amount.';
  end if;

  select * into v_sub from public.subscriptions s where s.id = p_subscription_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That subscription does not exist.';
  end if;

  v_paid_at := coalesce(p_paid_at, now());
  -- A payment dated in the future would move a subscription's period forward on the
  -- strength of money that has not arrived.
  if v_paid_at > now() + interval '1 day' then
    raise exception 'VALIDATION_FAILED' using detail = 'A payment cannot be dated in the future.';
  end if;

  -- The period this payment covers. Defaults to the subscription's current period, which
  -- is what recording an ordinary on-time payment means.
  v_start := coalesce(p_period_start, v_sub.current_period_start);
  v_end   := coalesce(p_period_end, v_sub.current_period_end);
  if v_end <= v_start then
    raise exception 'VALIDATION_FAILED' using detail = 'A billing period must end after it starts.';
  end if;

  /*
   * The fingerprint is taken from what the CALLER sent, not from the resolved period.
   *
   * v_start and v_end default to the subscription's current period — which the first
   * successful call advances. Fingerprinting those meant an honest retry computed a
   * different fingerprint and was rejected as key reuse, so the one case idempotency
   * exists for was the one case it refused. The caller's own arguments do not move.
   */
  v_fingerprint := encode(
    extensions.digest(
      p_subscription_id::text || '|' || p_amount::text || '|'
        || coalesce(p_period_start::text, '') || '|' || coalesce(p_period_end::text, ''),
      'sha256'
    ),
    'hex'
  );

  -- The claim: an existing key with the same fingerprint means this is a retry.
  select * into v_existing
    from public.idempotency_keys k
   where k.tenant_id = v_sub.tenant_id
     and k.key = p_idempotency_key
     and k.operation = 'record_subscription_payment';

  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      -- The same key used for a different payment. Refusing is the only safe answer:
      -- either the caller has a bug, or two different payments are about to be conflated.
      raise exception 'IDEMPOTENCY_KEY_REUSED'
        using detail = 'That idempotency key was already used for a different payment.';
    end if;
    if v_existing.status = 'SUCCEEDED' then
      select s.status, s.current_period_end into v_new_status, v_end
        from public.subscriptions s where s.id = p_subscription_id;
      return query select v_existing.result_id, v_new_status, v_end, true;
      return;
    end if;
    delete from public.idempotency_keys where id = v_existing.id;
  end if;

  insert into public.idempotency_keys
    (tenant_id, key, operation, request_fingerprint, status, user_id)
  values
    (v_sub.tenant_id, p_idempotency_key, 'record_subscription_payment', v_fingerprint,
     'IN_PROGRESS', auth.uid());

  insert into public.subscription_payments
    (subscription_id, tenant_id, amount, currency_code, method, reference,
     period_start, period_end, paid_at, recorded_by, notes)
  values
    (p_subscription_id, v_sub.tenant_id, p_amount, v_sub.currency_code, p_method, p_reference,
     v_start, v_end, v_paid_at, auth.uid(), p_notes)
  returning id into v_payment_id;

  /*
   * What the payment does to the subscription.
   *
   * Only a payment covering the current period moves it forward. A merchant settling an
   * old arrears invoice has paid a real debt, and it is recorded as one — but it does not
   * buy them next month, and quietly advancing the period would give away a month of
   * service every time someone paid late.
   */
  if v_end >= v_sub.current_period_end then
    update public.subscriptions
       set status               = 'ACTIVE',
           current_period_start = v_end,
           current_period_end   = v_end + case v_sub.interval
                                    when 'MONTHLY'   then interval '1 month'
                                    when 'QUARTERLY' then interval '3 months'
                                    when 'ANNUAL'    then interval '1 year'
                                  end
     where id = p_subscription_id
     returning status, current_period_end into v_new_status, v_end;

    /*
     * A paying customer trades again — but only one that was never actually suspended.
     *
     * A tenant in TRIAL or GRACE_PERIOD is still operating, and payment simply confirms
     * them. A SUSPENDED tenant is deliberately NOT reinstated here: suspension is an
     * operator's decision, it may have been for abuse rather than money, and reversing it
     * silently on receipt of a payment takes that decision away from the person who made
     * it. Reinstatement is `reactivate_tenant`, which is explicit and audited.
     *
     * The parenthesisation is load-bearing. Written without it, AND binds tighter than OR
     * and the second branch carries no tenant filter at all — recording a single payment
     * would reactivate every matching tenant on the platform.
     */
    update public.tenants
       set status = 'ACTIVE'
     where id = v_sub.tenant_id
       and status in ('TRIAL', 'GRACE_PERIOD');
  else
    select s.status, s.current_period_end into v_new_status, v_end
      from public.subscriptions s where s.id = p_subscription_id;
  end if;

  if p_invoice_id is not null then
    update public.subscription_invoices
       set status = 'PAID', paid_at = v_paid_at, paid_by_payment_id = v_payment_id
     where id = p_invoice_id
       and tenant_id = v_sub.tenant_id
       and status in ('ISSUED', 'OVERDUE');
  end if;

  update public.idempotency_keys
     set status = 'SUCCEEDED', result_id = v_payment_id, completed_at = now()
   where tenant_id = v_sub.tenant_id and key = p_idempotency_key;

  insert into public.audit_logs
    (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_sub.tenant_id, auth.uid(), 'SUBSCRIPTION_PAYMENT_RECORDED', 'subscription_payment',
    v_payment_id,
    -- The reference is recorded because it is how a payment is traced back to a bank or
    -- mobile-money record. It is not a credential.
    jsonb_build_object(
      'amount', p_amount, 'method', p_method, 'reference', p_reference,
      'period_start', v_start, 'period_end', v_end, 'invoice_id', p_invoice_id
    )
  );

  return query select v_payment_id, v_new_status, v_end, false;
end;
$$;

revoke execute on function record_subscription_payment from public, anon;
grant execute on function record_subscription_payment to authenticated;

comment on function record_subscription_payment is
  'Records a manually collected subscription payment and advances the period. Idempotent.';

-- -----------------------------------------------------------------------------
-- issue_invoice
--
-- Produces the document that asks a merchant to pay. Issued straight away rather than
-- drafted: a draft nobody sends is a subscription nobody collects, and Carl's billing is
-- collected by a person chasing it.
-- -----------------------------------------------------------------------------
create or replace function issue_invoice(
  p_subscription_id uuid,
  p_period_start    timestamptz default null,
  p_period_end      timestamptz default null,
  p_amount          bigint default null,
  p_due_at          timestamptz default null,
  p_notes           text default null
)
returns table (invoice_id uuid, invoice_number text, amount bigint, due_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub     record;
  v_id      uuid;
  v_number  text;
  v_start   timestamptz;
  v_end     timestamptz;
  v_amount  bigint;
  v_due     timestamptz;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may issue an invoice.';
  end if;

  select * into v_sub from public.subscriptions s where s.id = p_subscription_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That subscription does not exist.';
  end if;

  -- The subscription is the source of every figure. An override is allowed but explicit.
  v_start  := coalesce(p_period_start, v_sub.current_period_start);
  v_end    := coalesce(p_period_end, v_sub.current_period_end);
  v_amount := coalesce(p_amount, v_sub.price);
  -- Due at the end of the period plus the grace the customer was promised. Inventing a
  -- shorter deadline than the subscription's own grace period would make a customer
  -- overdue while still inside terms they were given.
  v_due    := coalesce(p_due_at, v_end + make_interval(days => v_sub.grace_days));

  if v_amount <= 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'An invoice must be for a positive amount.';
  end if;
  if v_end <= v_start then
    raise exception 'VALIDATION_FAILED' using detail = 'A billing period must end after it starts.';
  end if;

  v_number := app.next_invoice_number();

  begin
    insert into public.subscription_invoices
      (invoice_number, tenant_id, subscription_id, period_start, period_end,
       amount, currency_code, status, issued_at, due_at, notes, created_by)
    values
      (v_number, v_sub.tenant_id, p_subscription_id, v_start, v_end,
       v_amount, v_sub.currency_code, 'ISSUED', now(), v_due, p_notes, auth.uid())
    returning id into v_id;
  exception
    when unique_violation then
      -- The partial unique index on (subscription, period). Billing the same month twice
      -- is the mistake that produces a merchant with two bills and a complaint.
      raise exception 'DUPLICATE_INVOICE'
        using detail = 'An invoice already exists for that subscription and billing period.';
  end;

  insert into public.audit_logs
    (tenant_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_sub.tenant_id, auth.uid(), 'INVOICE_ISSUED', 'subscription_invoice', v_id,
    jsonb_build_object('invoice_number', v_number, 'amount', v_amount,
                       'period_start', v_start, 'period_end', v_end, 'due_at', v_due)
  );

  return query select v_id, v_number, v_amount, v_due;
end;
$$;

revoke execute on function issue_invoice from public, anon;
grant execute on function issue_invoice to authenticated;

-- -----------------------------------------------------------------------------
-- suspend_tenant / reactivate_tenant
--
-- The commercial stop and start. Suspension prevents a business from transacting, so it
-- is deliberately not a side effect of anything: it requires a reason, which is stored,
-- and it is audited.
-- -----------------------------------------------------------------------------
create or replace function suspend_tenant(p_tenant_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.tenant_status;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may suspend a business.';
  end if;

  -- A CHECK constraint on `tenants` already requires a reason. Failing here instead gives
  -- the operator a sentence they can act on rather than a constraint name.
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'VALIDATION_FAILED'
      using detail = 'A suspension must record why. It stops a business from trading.';
  end if;

  select status into v_before from public.tenants where id = p_tenant_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That business does not exist.';
  end if;
  if v_before = 'CANCELLED' then
    raise exception 'VALIDATION_FAILED' using detail = 'That business has already been cancelled.';
  end if;

  update public.tenants
     set status = 'SUSPENDED', suspended_at = now(), suspension_reason = p_reason
   where id = p_tenant_id;

  update public.subscriptions
     set status = 'SUSPENDED'
   where tenant_id = p_tenant_id and status <> 'CANCELLED';

  insert into public.audit_logs
    (tenant_id, actor_id, action, entity_type, entity_id, before_state, after_state, metadata)
  values (
    p_tenant_id, auth.uid(), 'TENANT_SUSPENDED', 'tenant', p_tenant_id,
    jsonb_build_object('status', v_before), jsonb_build_object('status', 'SUSPENDED'),
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

create or replace function reactivate_tenant(p_tenant_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.tenant_status;
begin
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a platform administrator may reactivate a business.';
  end if;

  select status into v_before from public.tenants where id = p_tenant_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'That business does not exist.';
  end if;
  -- A cancelled business is ended, not paused. Bringing one back is an onboarding
  -- decision with its own commercial terms, not a status flip.
  if v_before = 'CANCELLED' then
    raise exception 'VALIDATION_FAILED'
      using detail = 'A cancelled business cannot be reactivated. Onboard it again.';
  end if;

  update public.tenants
     set status = 'ACTIVE', suspended_at = null, suspension_reason = null
   where id = p_tenant_id;

  update public.subscriptions
     set status = 'ACTIVE'
   where tenant_id = p_tenant_id and status = 'SUSPENDED';

  insert into public.audit_logs
    (tenant_id, actor_id, action, entity_type, entity_id, before_state, after_state, metadata)
  values (
    p_tenant_id, auth.uid(), 'TENANT_REACTIVATED', 'tenant', p_tenant_id,
    jsonb_build_object('status', v_before), jsonb_build_object('status', 'ACTIVE'),
    jsonb_build_object('note', p_note)
  );
end;
$$;

revoke execute on function suspend_tenant from public, anon;
revoke execute on function reactivate_tenant from public, anon;
grant execute on function suspend_tenant to authenticated;
grant execute on function reactivate_tenant to authenticated;

comment on function suspend_tenant is
  'Stops a business trading. Requires a reason, cascades to its subscription, and is audited.';
