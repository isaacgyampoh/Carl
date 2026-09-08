-- =============================================================================
-- 0022 · Cash register sessions
--
-- ## What this is for
--
-- At the end of a shift someone counts the drawer. Carl must be able to say what should
-- be in it, so a difference can be investigated while the shift is still fresh and the
-- people involved are still on site.
--
--     expected = opening float
--              + cash sales
--              - cash refunds
--              + cash paid in
--              - cash paid out
--              - cash expenses
--
-- ## Why the variance is stored, not computed
--
-- The variance is a fact about that shift: what was counted, against what the system
-- believed at that moment. Recomputing it later against corrected data would erase the
-- discrepancy that was actually found — which is the only thing the record exists to
-- preserve.
-- =============================================================================

create or replace function open_cash_session(
  p_register_id   uuid,
  p_opening_float bigint default 0,
  p_device_id     uuid default null
)
returns table (session_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_register record;
  v_session_id uuid;
begin
  select r.* into v_register from public.cash_registers r where r.id = p_register_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Register not found.';
  end if;

  if not app.has_permission(v_register.tenant_id, 'register.open', v_register.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_register.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if not app.can_access_branch(v_register.branch_id) then
    raise exception 'FORBIDDEN_BRANCH';
  end if;

  if p_opening_float < 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'An opening float cannot be negative.';
  end if;

  -- One open session per register. Two would each record a partial view of the same
  -- physical drawer and neither would reconcile. The partial unique index enforces this
  -- as well; checking here produces a message a cashier can act on.
  if exists (
    select 1 from public.cash_sessions s
    where s.register_id = p_register_id and s.status = 'OPEN'
  ) then
    raise exception 'REGISTER_ALREADY_OPEN'
      using detail = 'This register already has an open session. Close it before opening another.';
  end if;

  insert into public.cash_sessions
    (tenant_id, branch_id, register_id, device_id, opening_float, opened_by)
  values
    (v_register.tenant_id, v_register.branch_id, p_register_id, p_device_id, p_opening_float, auth.uid())
  returning id into v_session_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, device_id, metadata)
  values (
    v_register.tenant_id, v_register.branch_id, auth.uid(),
    'CASH_SESSION_OPENED', 'cash_session', v_session_id, p_device_id,
    jsonb_build_object('opening_float', p_opening_float)
  );

  return query select v_session_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- record_cash_movement
--
-- Money into or out of the drawer that is not a sale: a float top-up, a safe drop, petty
-- cash. Each one moves what the drawer should hold, so each must be recorded or the
-- reconciliation is meaningless.
-- -----------------------------------------------------------------------------

create or replace function record_cash_movement(
  p_session_id    uuid,
  p_movement_type cash_movement_type,
  p_amount        bigint,
  p_reason        text,
  p_notes         text default null
)
returns table (movement_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_movement_id uuid;
begin
  select s.* into v_session from public.cash_sessions s where s.id = p_session_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Cash session not found.';
  end if;

  if not app.has_permission(v_session.tenant_id, 'register.cash_movement', v_session.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_session.status <> 'OPEN' then
    raise exception 'REGISTER_SESSION_CLOSED';
  end if;

  if p_amount <= 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'A cash movement must be greater than zero.';
  end if;

  -- A reason is mandatory. Cash leaving a drawer with no explanation is the single most
  -- common route for till theft, and the record exists to make it answerable.
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'VALIDATION_FAILED' using detail = 'A reason is required for a cash movement.';
  end if;

  insert into public.cash_movements
    (session_id, tenant_id, branch_id, movement_type, amount, reason, notes, performed_by)
  values
    (p_session_id, v_session.tenant_id, v_session.branch_id, p_movement_type, p_amount,
     p_reason, p_notes, auth.uid())
  returning id into v_movement_id;

  -- DROP and PICKUP both remove cash from the drawer (to the safe, or to the bank);
  -- IN adds, OUT removes.
  update public.cash_sessions
     set cash_in  = cash_in  + case when p_movement_type = 'IN' then p_amount else 0 end,
         cash_out = cash_out + case when p_movement_type in ('OUT', 'DROP', 'PICKUP') then p_amount else 0 end
   where id = p_session_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_session.tenant_id, v_session.branch_id, auth.uid(),
    'CASH_MOVEMENT_RECORDED', 'cash_session', p_session_id,
    jsonb_build_object('type', p_movement_type, 'amount', p_amount, 'reason', p_reason)
  );

  return query select v_movement_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- close_cash_session
-- -----------------------------------------------------------------------------

create or replace function close_cash_session(
  p_session_id    uuid,
  p_counted_cash  bigint,
  p_variance_note text default null
)
returns table (
  expected_cash bigint,
  counted_cash  bigint,
  variance      bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  record;
  v_expected bigint;
  v_variance bigint;
begin
  select s.* into v_session from public.cash_sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Cash session not found.';
  end if;

  if not app.has_permission(v_session.tenant_id, 'register.close', v_session.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_session.status <> 'OPEN' then
    raise exception 'REGISTER_SESSION_CLOSED';
  end if;

  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'Enter the amount counted in the drawer.';
  end if;

  v_expected :=
      v_session.opening_float
    + v_session.cash_sales
    - v_session.cash_refunds
    + v_session.cash_in
    - v_session.cash_out
    - v_session.cash_expenses;

  v_variance := p_counted_cash - v_expected;

  -- A shortfall or surplus must be explained. Silent variances are how a slow leak from a
  -- till goes unnoticed for months; the CHECK on the table enforces this too.
  if v_variance <> 0 and (p_variance_note is null or length(btrim(p_variance_note)) < 3) then
    raise exception 'VALIDATION_FAILED'
      using detail = format(
        'The drawer is %s by %s. Record why before closing.',
        case when v_variance < 0 then 'short' else 'over' end,
        abs(v_variance)
      );
  end if;

  update public.cash_sessions
     set status        = 'CLOSED',
         expected_cash = v_expected,
         counted_cash  = p_counted_cash,
         variance      = v_variance,
         variance_note = p_variance_note,
         closed_at     = now(),
         closed_by     = auth.uid()
   where id = p_session_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_session.tenant_id, v_session.branch_id, auth.uid(),
    'CASH_SESSION_CLOSED', 'cash_session', p_session_id,
    jsonb_build_object(
      'expected', v_expected,
      'counted', p_counted_cash,
      'variance', v_variance,
      'note', p_variance_note
    )
  );

  return query select v_expected, p_counted_cash, v_variance;
end;
$$;

comment on function close_cash_session(uuid, bigint, text) is
  'Reconciles a drawer. The variance is stored, not recomputed later - it is a fact about that shift.';

-- -----------------------------------------------------------------------------
-- record_expense
--
-- ## The approval policy, and its limits
--
-- Recording and approving are separate permissions. An expense entered by someone who
-- cannot approve goes to a queue; one entered by someone who can is approved on entry.
--
-- That second case is deliberate, not an oversight. A single-manager shop has nobody else
-- to sign off, and a control that makes the feature unusable gets worked around rather
-- than followed. The person holding `expenses.approve` is trusted with the business's
-- money by definition.
--
-- What is still prevented is the sharper version: recording an expense while unable to
-- approve it, and approving it yourself later. `approve_expense` refuses that even if the
-- permission is granted in between — see the check there.
--
-- A tenant that genuinely needs four-eyes on every expense would need a setting to enforce
-- it. That is a real requirement for larger businesses and is not implemented here; it is
-- noted rather than silently assumed away.
-- -----------------------------------------------------------------------------

create or replace function record_expense(
  p_branch_id    uuid,
  p_description  text,
  p_amount       bigint,
  p_category_id  uuid default null,
  p_method       payment_method default 'CASH',
  p_reference    text default null,
  p_expense_date date default null,
  p_receipt_url  text default null
)
returns table (expense_id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch     record;
  v_expense_id uuid;
  v_reference  text;
  v_session_id uuid;
  v_needs_approval boolean;
begin
  select b.* into v_branch from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  if not app.has_permission(v_branch.tenant_id, 'expenses.create', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_branch.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if not app.can_access_branch(p_branch_id) then
    raise exception 'FORBIDDEN_BRANCH';
  end if;

  if p_amount <= 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'An expense must be greater than zero.';
  end if;

  if p_method in ('MOMO', 'BANK_TRANSFER')
     and (p_reference is null or length(btrim(p_reference)) = 0) then
    raise exception 'PAYMENT_REFERENCE_REQUIRED';
  end if;

  -- Someone who can also approve does not need a second pair of eyes on their own entry;
  -- anyone else's goes to a queue.
  v_needs_approval := not app.has_permission(v_branch.tenant_id, 'expenses.approve', p_branch_id);

  select count(*) + 1 into v_reference from public.expenses where tenant_id = v_branch.tenant_id;
  v_reference := 'EXP-' || lpad(v_reference, 6, '0');

  select s.id into v_session_id
  from public.cash_sessions s
  where s.branch_id = p_branch_id and s.status = 'OPEN'
  order by s.opened_at desc
  limit 1;

  insert into public.expenses (
    tenant_id, branch_id, category_id, reference, description, amount, method,
    payment_reference, receipt_url, status, expense_date, cash_session_id,
    created_by, approved_by, approved_at
  )
  values (
    v_branch.tenant_id, p_branch_id, p_category_id, v_reference, p_description, p_amount,
    p_method, nullif(btrim(coalesce(p_reference, '')), ''), p_receipt_url,
    case when v_needs_approval then 'PENDING_APPROVAL'::public.expense_status
         else 'APPROVED'::public.expense_status end,
    coalesce(p_expense_date, current_date), v_session_id,
    auth.uid(),
    case when v_needs_approval then null else auth.uid() end,
    case when v_needs_approval then null else now() end
  )
  returning id into v_expense_id;

  -- Cash leaving the drawer changes what should be in it. Only once approved: an expense
  -- awaiting sign-off has not been paid out yet.
  if v_session_id is not null and p_method = 'CASH' and not v_needs_approval then
    update public.cash_sessions
       set cash_expenses = cash_expenses + p_amount
     where id = v_session_id;
  end if;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_branch.tenant_id, p_branch_id, auth.uid(), 'EXPENSE_CREATED', 'expense', v_expense_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'reference', v_reference)
  );

  return query select v_expense_id, v_reference;
end;
$$;

create or replace function approve_expense(p_expense_id uuid)
returns table (approved_expense_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense record;
begin
  select e.* into v_expense from public.expenses e where e.id = p_expense_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Expense not found.';
  end if;

  if not app.has_permission(v_expense.tenant_id, 'expenses.approve', v_expense.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_expense.status = 'APPROVED' then
    raise exception 'CONFLICT' using detail = 'This expense is already approved.';
  end if;

  -- The case this guards: an expense was recorded by someone who could not approve it, and
  -- they later acquire the permission. Approving it themselves at that point would defeat
  -- the queue entirely. (An expense recorded BY an approver is already approved and never
  -- reaches here — see the policy note on record_expense.)
  if v_expense.created_by = auth.uid() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'A queued expense must be approved by someone other than the person who recorded it.';
  end if;

  update public.expenses
     set status = 'APPROVED', approved_by = auth.uid(), approved_at = now()
   where id = p_expense_id;

  if v_expense.cash_session_id is not null and v_expense.method = 'CASH' then
    update public.cash_sessions
       set cash_expenses = cash_expenses + v_expense.amount
     where id = v_expense.cash_session_id and status = 'OPEN';
  end if;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_expense.tenant_id, v_expense.branch_id, auth.uid(),
    'EXPENSE_APPROVED', 'expense', p_expense_id,
    jsonb_build_object('amount', v_expense.amount, 'recorded_by', v_expense.created_by)
  );

  return query select p_expense_id;
end;
$$;

revoke execute on function open_cash_session(uuid, bigint, uuid) from public, anon;
revoke execute on function record_cash_movement(uuid, cash_movement_type, bigint, text, text) from public, anon;
revoke execute on function close_cash_session(uuid, bigint, text) from public, anon;
revoke execute on function record_expense(uuid, text, bigint, uuid, payment_method, text, date, text) from public, anon;
revoke execute on function approve_expense(uuid) from public, anon;

grant execute on function open_cash_session(uuid, bigint, uuid) to authenticated, service_role;
grant execute on function record_cash_movement(uuid, cash_movement_type, bigint, text, text) to authenticated, service_role;
grant execute on function close_cash_session(uuid, bigint, text) to authenticated, service_role;
grant execute on function record_expense(uuid, text, bigint, uuid, payment_method, text, date, text) to authenticated, service_role;
grant execute on function approve_expense(uuid) to authenticated, service_role;
