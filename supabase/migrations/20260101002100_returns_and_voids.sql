-- =============================================================================
-- 0021 · Returns, refunds and voids
--
-- ## Void versus return
--
-- These are different events and Carl keeps them apart.
--
--   A VOID cancels a sale that should never have happened — rung up twice, wrong
--   customer, keyed in error. It reverses the whole thing and is only reasonable while
--   the customer is still at the counter. It requires `sales.void`.
--
--   A RETURN is a customer bringing goods back. The original sale remains valid and part
--   of the day's trade; the return is a separate, later event with its own record and its
--   own number. It requires `sales.refund`.
--
-- Treating a return as a void would erase the original sale from the day's takings, which
-- is both wrong for reporting and looks, in an audit, like a deleted transaction.
--
-- ## Returned goods do not always go back on the shelf
--
-- A damaged or expired item comes back but must not be resold. `restocked` is decided per
-- return rather than assumed, and stock only moves when it is true.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- void_sale
-- -----------------------------------------------------------------------------

create or replace function void_sale(
  p_sale_id uuid,
  p_reason  text
)
returns table (voided_sale_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale record;
  v_item record;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id;
  if not found then
    raise exception 'SALE_NOT_FOUND';
  end if;

  if not app.has_permission(v_sale.tenant_id, 'sales.void', v_sale.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_sale.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if v_sale.status = 'VOIDED' then
    raise exception 'SALE_ALREADY_VOIDED';
  end if;

  -- A sale with returns against it cannot be voided: the return already reversed part of
  -- it, and voiding the remainder would double-count the stock coming back.
  if v_sale.amount_refunded > 0 then
    raise exception 'CONFLICT'
      using detail = 'This sale has been partly returned and cannot be voided. Return the remainder instead.';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'VALIDATION_FAILED' using detail = 'A reason is required to void a sale.';
  end if;

  -- Restore stock, one SALE_VOID movement per line. Not by deleting the original SALE
  -- movements: the ledger is append-only, and a reversal that leaves no trace is exactly
  -- what makes a stock history untrustworthy.
  for v_item in select * from public.sale_items where sale_id = p_sale_id
  loop
    perform app.apply_movement(
      v_sale.tenant_id, v_sale.branch_id, v_item.product_id, 'SALE_VOID',
      v_item.quantity, v_item.unit_cost, 'sale_void', p_sale_id,
      format('Void: %s', p_reason), v_sale.device_id
    );
  end loop;

  update public.sales
     set status = 'VOIDED', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   where id = p_sale_id;

  -- The drawer no longer holds that cash.
  if v_sale.cash_session_id is not null then
    update public.cash_sessions
       set cash_sales = greatest(
             cash_sales - coalesce(
               (select sum(sp.amount) from public.sale_payments sp
                 where sp.sale_id = p_sale_id and sp.method = 'CASH'),
               0
             ) + v_sale.change_given,
             0
           )
     where id = v_sale.cash_session_id;
  end if;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, device_id, metadata)
  values (
    v_sale.tenant_id, v_sale.branch_id, auth.uid(), 'SALE_VOIDED', 'sale', p_sale_id,
    v_sale.device_id,
    jsonb_build_object('sale_number', v_sale.sale_number, 'total', v_sale.total, 'reason', p_reason)
  );

  return query select p_sale_id;
end;
$$;

revoke execute on function void_sale(uuid, text) from public, anon;
grant execute on function void_sale(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- app.next_return_number
-- -----------------------------------------------------------------------------

create or replace function app.next_return_number(p_branch_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code     text;
  v_sequence integer;
begin
  select b.code into v_code from public.branches b where b.id = p_branch_id for update;

  select count(*) + 1 into v_sequence
  from public.sale_returns r
  where r.branch_id = p_branch_id
    and r.returned_at >= date_trunc('day', now());

  return 'RTN-' || upper(v_code) || '-' || to_char(now(), 'YYMMDD') || '-' || lpad(v_sequence::text, 4, '0');
end;
$$;

-- -----------------------------------------------------------------------------
-- process_return
--
-- ## Why quantity_returned is tracked per line
--
-- A customer may return two of five items today and two more next week. Without a running
-- total per line, the third return of the same line could exceed what was sold — and the
-- shop would refund goods it never supplied. `sale_items.quantity_returned` is checked and
-- incremented inside this transaction, so partial returns compose correctly.
--
-- ## Refunds are valued at what was paid
--
-- The unit price comes from the original `sale_items` row, not from today's catalogue.
-- A customer is refunded what they were charged, whether the price has since risen or
-- fallen.
-- -----------------------------------------------------------------------------

create or replace function process_return(
  p_sale_id         uuid,
  p_items           jsonb,
  p_reason          text,
  p_idempotency_key text,
  p_refund_method   payment_method default null,
  p_refund_reference text default null,
  p_restocked       boolean default true,
  p_notes           text default null
)
returns table (
  return_id      uuid,
  return_number  text,
  total          bigint,
  was_replayed   boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale        record;
  v_return_id   uuid;
  v_number      text;
  v_item        jsonb;
  v_sale_item   record;
  v_quantity    numeric;
  v_line_total  bigint;
  v_line_tax    bigint;
  v_subtotal    bigint := 0;
  v_tax_total   bigint := 0;
  v_total       bigint;
  v_existing    record;
  v_fingerprint text;
  v_refunded    bigint;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id;
  if not found then
    raise exception 'SALE_NOT_FOUND';
  end if;

  if not app.has_permission(v_sale.tenant_id, 'sales.refund', v_sale.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_sale.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if v_sale.status = 'VOIDED' then
    raise exception 'SALE_ALREADY_VOIDED'
      using detail = 'This sale was voided; there is nothing to return.';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'VALIDATION_FAILED' using detail = 'A reason is required for a return.';
  end if;

  -- Idempotency, for the same reason sales have it: a lost response, or an offline
  -- terminal replaying its queue, must not refund the customer twice.
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'SYNC_PAYLOAD_INVALID' using detail = 'A valid idempotency key is required.';
  end if;

  v_fingerprint := encode(
    extensions.digest(p_sale_id::text || '|' || coalesce(p_items::text, ''), 'sha256'),
    'hex'
  );

  select k.* into v_existing
  from public.idempotency_keys k
  where k.tenant_id = v_sale.tenant_id
    and k.operation = 'process_return'
    and k.key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if v_existing.status = 'SUCCEEDED' then
      return query
        select r.id, r.return_number, r.total::bigint, true
        from public.sale_returns r
        where r.id = v_existing.result_id;
      return;
    end if;
    delete from public.idempotency_keys where id = v_existing.id;
  end if;

  insert into public.idempotency_keys
    (tenant_id, key, operation, request_fingerprint, status, user_id)
  values
    (v_sale.tenant_id, p_idempotency_key, 'process_return', v_fingerprint, 'IN_PROGRESS', auth.uid());

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'Select at least one item to return.';
  end if;

  if p_refund_method in ('MOMO', 'BANK_TRANSFER')
     and (p_refund_reference is null or length(btrim(p_refund_reference)) = 0) then
    raise exception 'PAYMENT_REFERENCE_REQUIRED';
  end if;

  v_return_id := gen_random_uuid();
  v_number := app.next_return_number(v_sale.branch_id);

  insert into public.sale_returns (
    id, tenant_id, branch_id, sale_id, return_number, reason, notes,
    subtotal, tax_amount, total, refund_method, refund_reference, refunded_amount,
    restocked, processed_by, device_id, cash_session_id
  )
  values (
    v_return_id, v_sale.tenant_id, v_sale.branch_id, p_sale_id, v_number, p_reason, p_notes,
    0, 0, 0, p_refund_method, nullif(btrim(coalesce(p_refund_reference, '')), ''), 0,
    p_restocked, auth.uid(), v_sale.device_id, v_sale.cash_session_id
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_quantity := (v_item ->> 'quantity')::numeric;

    select si.* into v_sale_item
    from public.sale_items si
    where si.id = (v_item ->> 'sale_item_id')::uuid
      and si.sale_id = p_sale_id
    -- Locked so two returns of the same line cannot each read the same
    -- quantity_returned and both be allowed.
    for update;

    if not found then
      raise exception 'NOT_FOUND' using detail = 'That line is not part of this sale.';
    end if;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    -- The check that stops a shop refunding goods it never supplied.
    if v_sale_item.quantity_returned + v_quantity > v_sale_item.quantity then
      raise exception 'RETURN_EXCEEDS_SOLD_QUANTITY'
        using detail = format(
          '%s of %s were sold and %s already returned.',
          v_sale_item.quantity, v_sale_item.product_name, v_sale_item.quantity_returned
        );
    end if;

    -- Valued at the price actually charged, apportioned for a partial return so any
    -- line discount is refunded in the same proportion.
    v_line_total := round((v_sale_item.line_total::numeric / v_sale_item.quantity) * v_quantity)::bigint;
    v_line_tax   := round((v_sale_item.tax_amount::numeric / v_sale_item.quantity) * v_quantity)::bigint;

    insert into public.sale_return_items
      (return_id, sale_item_id, tenant_id, product_id, quantity, unit_price, tax_amount, line_total, condition)
    values (
      v_return_id, v_sale_item.id, v_sale.tenant_id, v_sale_item.product_id, v_quantity,
      v_sale_item.unit_price, v_line_tax, v_line_total,
      coalesce(v_item ->> 'condition', 'RESALEABLE')
    );

    update public.sale_items
       set quantity_returned = quantity_returned + v_quantity
     where id = v_sale_item.id;

    -- Damaged goods come back but must not be resold, so stock only moves when the
    -- return is marked as restocked.
    if p_restocked and coalesce(v_item ->> 'condition', 'RESALEABLE') = 'RESALEABLE' then
      perform app.apply_movement(
        v_sale.tenant_id, v_sale.branch_id, v_sale_item.product_id, 'SALE_RETURN',
        v_quantity, v_sale_item.unit_cost, 'sale_return', v_return_id, p_reason, v_sale.device_id
      );
    end if;

    v_subtotal  := v_subtotal + v_line_total - v_line_tax;
    v_tax_total := v_tax_total + v_line_tax;
  end loop;

  v_total := v_subtotal + v_tax_total;
  v_refunded := case when p_refund_method is null then 0 else v_total end;

  -- A refund can never exceed what the customer actually paid, across every return
  -- against this sale.
  if v_sale.amount_refunded + v_refunded > v_sale.total then
    raise exception 'REFUND_EXCEEDS_PAID'
      using detail = 'The total refunded would exceed what was paid for this sale.';
  end if;

  update public.sale_returns
     set subtotal = v_subtotal, tax_amount = v_tax_total, total = v_total,
         refunded_amount = v_refunded
   where public.sale_returns.id = v_return_id;

  -- Column references are table-qualified because `total` is also the name of an OUT
  -- parameter of this function, and plpgsql cannot otherwise tell them apart.
  update public.sales
     set amount_refunded = public.sales.amount_refunded + v_refunded,
         status = case
           when public.sales.amount_refunded + v_refunded >= public.sales.total
             then 'RETURNED'::public.sale_status
           else 'PARTIALLY_RETURNED'::public.sale_status
         end
   where public.sales.id = p_sale_id;

  if v_sale.cash_session_id is not null and p_refund_method = 'CASH' then
    update public.cash_sessions
       set cash_refunds = cash_refunds + v_refunded
     where id = v_sale.cash_session_id;
  end if;

  update public.idempotency_keys
     set status = 'SUCCEEDED', result_id = v_return_id, completed_at = now()
   where tenant_id = v_sale.tenant_id
     and operation = 'process_return'
     and key = p_idempotency_key;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_sale.tenant_id, v_sale.branch_id, auth.uid(), 'SALE_REFUNDED', 'sale_return', v_return_id,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'sale_number', v_sale.sale_number,
      'return_number', v_number,
      'total', v_total,
      'restocked', p_restocked,
      'reason', p_reason
    )
  );

  return query select v_return_id, v_number, v_total, false;
end;
$$;

comment on function process_return is
  'Records a return against a sale. Refunds at the price originally charged; partial returns compose via sale_items.quantity_returned.';

revoke execute on function process_return from public, anon;
grant execute on function process_return to authenticated, service_role;
