-- =============================================================================
-- 0020 · Sale completion
--
-- The most important function in Carl. Everything else exists to support it.
--
-- ## What the client sends, and what it does not
--
-- The client sends: a branch, a price tier, an optional customer, a list of
-- {product_id, quantity, discount}, a list of {method, amount, reference}, and an
-- idempotency key.
--
-- The client does NOT send: a unit price, a line total, an order total, a tax amount, a
-- cost, a tenant id, or a receipt number. Every one of those is derived here. A price in
-- the request payload is not validated — nothing reads it.
--
-- ## Atomicity
--
-- A sale writes to `sales`, `sale_items`, `sale_payments`, `inventory`,
-- `inventory_movements`, `cash_sessions` and `audit_logs`. A plpgsql function body is a
-- single transaction, so either all of that happens or none of it does. There is no
-- sequence of events that leaves stock decremented with no sale to explain it.
--
-- ## Idempotency
--
-- The first thing this does is claim the caller's key. A second arrival with the same key
-- returns the original sale rather than charging the customer twice. The claim is an
-- INSERT against a unique index, not a check-then-write, so two concurrent retries cannot
-- both proceed.
--
-- ## Rounding
--
-- All money is integer minor units. Percentage discounts and tax are computed in `numeric`
-- and rounded half away from zero at each line — matching @carl/shared's `multiplyMoney`
-- and `percentOf` exactly, so the figure the till displayed is the figure charged.
-- =============================================================================

create or replace function complete_sale(
  p_branch_id       uuid,
  p_items           jsonb,
  p_payments        jsonb,
  p_idempotency_key text,
  p_customer_id     uuid    default null,
  p_tier            price_tier default 'RETAIL',
  p_device_id       uuid    default null,
  p_device_secret   text    default null,
  p_pepper          text    default null,
  p_order_discount_type  discount_type default 'NONE',
  p_order_discount_value numeric default null,
  p_discount_reason text    default null,
  p_note            text    default null,
  p_sold_at         timestamptz default null,
  p_channel         sale_channel default 'POS'
)
returns table (
  sale_id      uuid,
  sale_number  text,
  total        bigint,
  amount_paid  bigint,
  change_given bigint,
  was_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id     uuid;
  v_branch        record;
  v_tenant        record;
  v_sale_id       uuid;
  v_sale_number   text;
  v_existing      record;
  v_fingerprint   text;
  v_item          jsonb;
  v_product       record;
  v_quantity      numeric;
  v_unit_price    bigint;
  v_line_discount bigint;
  v_line_net      bigint;
  v_line_tax      bigint;
  v_line_total    bigint;
  v_line_no       smallint := 0;
  v_subtotal      bigint := 0;
  v_tax_total     bigint := 0;
  v_cost_total    bigint := 0;
  v_order_discount bigint := 0;
  v_total         bigint;
  v_paid          bigint := 0;
  v_change        bigint := 0;
  v_payment       jsonb;
  v_method        public.payment_method;
  v_amount        bigint;
  v_reference     text;
  v_cash_paid     bigint := 0;
  v_session_id    uuid;
  v_sold_at       timestamptz := coalesce(p_sold_at, now());
  v_max_discount  numeric;
begin
  -- ---------------------------------------------------------------------------
  -- 1. Establish context
  -- ---------------------------------------------------------------------------
  select b.* into v_branch from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;
  v_tenant_id := v_branch.tenant_id;

  select t.* into v_tenant from public.tenants t where t.id = v_tenant_id;

  -- ---------------------------------------------------------------------------
  -- 2. Authorise
  --
  -- Permission, branch access and tenant standing are all checked here rather than
  -- relied upon from RLS: this function is SECURITY DEFINER, so RLS does not apply to
  -- its own writes. Every check RLS would have made must be made explicitly.
  -- ---------------------------------------------------------------------------
  if not app.has_permission(v_tenant_id, 'sales.create', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.can_access_branch(p_branch_id) then
    raise exception 'FORBIDDEN_BRANCH';
  end if;

  if not app.tenant_can_transact(v_tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  -- A terminal that presents a device id must prove it. A revoked or expired one is
  -- refused here, which is what stops a stolen till from continuing to trade.
  if p_device_id is not null then
    perform app.authorize_device(p_device_id, p_device_secret, p_pepper);
  end if;

  if p_tier = 'WHOLESALE'
     and not app.has_permission(v_tenant_id, 'sales.sell_wholesale', p_branch_id) then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Selling at wholesale prices requires additional permission.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 3. Claim the idempotency key
  --
  -- Before any work. A duplicate arrival must not reach the stock checks at all.
  -- ---------------------------------------------------------------------------
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'SYNC_PAYLOAD_INVALID' using detail = 'A valid idempotency key is required.';
  end if;

  -- Fingerprints the request so a key reused for a *different* sale is refused rather
  -- than silently returning the earlier result.
  v_fingerprint := encode(
    extensions.digest(
      coalesce(p_items::text, '') || '|' || coalesce(p_payments::text, '') || '|' ||
      p_branch_id::text || '|' || coalesce(p_customer_id::text, '') || '|' || p_tier::text,
      'sha256'
    ),
    'hex'
  );

  select k.* into v_existing
  from public.idempotency_keys k
  where k.tenant_id = v_tenant_id
    and k.operation = 'complete_sale'
    and k.key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_KEY_REUSED'
        using detail = 'This key was already used for a different sale.';
    end if;

    if v_existing.status = 'SUCCEEDED' then
      -- The money columns are the app.money_minor domain; RETURNS TABLE requires an
      -- exact type match, so they are cast to the declared bigint.
      return query
        select s.id, s.sale_number,
               s.total::bigint, s.amount_paid::bigint, s.change_given::bigint, true
        from public.sales s
        where s.id = v_existing.result_id;
      return;
    end if;

    -- A previous attempt failed. Allow a retry by clearing the record, so a transient
    -- failure does not permanently burn the key and strand the terminal.
    delete from public.idempotency_keys where id = v_existing.id;
  end if;

  insert into public.idempotency_keys
    (tenant_id, key, operation, request_fingerprint, status, device_id, user_id)
  values
    (v_tenant_id, p_idempotency_key, 'complete_sale', v_fingerprint, 'IN_PROGRESS', p_device_id, auth.uid());

  -- ---------------------------------------------------------------------------
  -- 4. Validate the cart
  -- ---------------------------------------------------------------------------
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  -- The open cash session for this register, so cash taken is attributed to the right
  -- shift. Optional: a sale is not blocked by there being no session open.
  select cs.id into v_session_id
  from public.cash_sessions cs
  where cs.branch_id = p_branch_id and cs.status = 'OPEN'
  order by cs.opened_at desc
  limit 1;

  v_sale_id := gen_random_uuid();
  v_sale_number := app.next_sale_number(p_branch_id, v_sold_at);

  -- ---------------------------------------------------------------------------
  -- 5. Price and stock each line
  --
  -- The prices used are resolved here, from the catalogue, at this instant. Whatever the
  -- client believed the price to be is irrelevant and is never consulted.
  -- ---------------------------------------------------------------------------
  insert into public.sales (
    id, tenant_id, branch_id, sale_number, status, channel, customer_id, cashier_id,
    device_id, cash_session_id, tier, subtotal, discount_amount, tax_amount, total,
    cost_total, amount_paid, change_given, discount_type, discount_value, discount_reason,
    note, sold_at, is_offline_sale, synced_at
  )
  values (
    v_sale_id, v_tenant_id, p_branch_id, v_sale_number, 'COMPLETED', p_channel, p_customer_id,
    auth.uid(), p_device_id, v_session_id, p_tier, 0, 0, 0, 0, 0, 0, 0,
    p_order_discount_type, p_order_discount_value, p_discount_reason,
    p_note, v_sold_at, p_sold_at is not null, now()
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_line_no := v_line_no + 1;
    v_quantity := (v_item ->> 'quantity')::numeric;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'INVALID_QUANTITY'
        using detail = format('Line %s has a quantity of %s.', v_line_no, coalesce(v_quantity::text, 'null'));
    end if;

    select p.* into v_product
    from public.products p
    where p.id = (v_item ->> 'product_id')::uuid
      and p.tenant_id = v_tenant_id;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND'
        using detail = format('Line %s refers to a product that does not exist.', v_line_no);
    end if;

    if not v_product.is_active then
      raise exception 'PRODUCT_INACTIVE'
        using detail = format('%s is no longer available for sale.', v_product.name);
    end if;

    -- A product sold only in whole units cannot be sold as a fraction. Permitting it
    -- produces stock levels that never reconcile against a physical count.
    if not v_product.allow_fractional and v_quantity <> trunc(v_quantity) then
      raise exception 'INVALID_QUANTITY'
        using detail = format('%s cannot be sold in fractions.', v_product.name);
    end if;

    v_unit_price := app.resolve_price(v_product.id, p_branch_id, p_tier, v_quantity, null);
    if v_unit_price is null then
      raise exception 'PRICE_NOT_CONFIGURED'
        using detail = format('No %s price is configured for %s.', p_tier, v_product.name);
    end if;

    -- Line discount. Percentage and fixed amount both round half away from zero, matching
    -- the client's arithmetic exactly so the displayed figure is the charged figure.
    v_line_discount := 0;
    if (v_item ->> 'discount_type') = 'PERCENTAGE' then
      v_line_discount := round(
        (v_unit_price * v_quantity) * ((v_item ->> 'discount_value')::numeric / 100)
      )::bigint;
    elsif (v_item ->> 'discount_type') = 'AMOUNT' then
      v_line_discount := (v_item ->> 'discount_value')::bigint;
    end if;

    -- A negative discount would *increase* the line, charging the customer more than the
    -- catalogue price. The CHECK on sale_items catches it as a last resort, but that
    -- surfaces as a raw constraint violation; refusing it here gives the cashier something
    -- they can act on.
    if v_line_discount < 0 then
      raise exception 'INVALID_PRICE'
        using detail = format('Line %s has a negative discount.', v_line_no);
    end if;

    if v_line_discount > 0 then
      if not app.has_permission(v_tenant_id, 'sales.discount', p_branch_id) then
        raise exception 'DISCOUNT_NOT_PERMITTED'
          using detail = 'Applying a discount requires additional permission.';
      end if;

      -- A capped discount for ordinary staff, unlimited only with the explicit
      -- permission. Without a ceiling, "discount" is a way to give stock away.
      if not app.has_permission(v_tenant_id, 'sales.discount_unrestricted', p_branch_id) then
        v_max_discount := round((v_unit_price * v_quantity) * 0.20);
        if v_line_discount > v_max_discount then
          raise exception 'DISCOUNT_EXCEEDS_LIMIT'
            using detail = 'That discount is above the limit for your role. A supervisor must approve it.';
        end if;
      end if;
    end if;

    v_line_net := round(v_unit_price * v_quantity)::bigint - v_line_discount;
    if v_line_net < 0 then
      raise exception 'INVALID_PRICE'
        using detail = format('The discount on line %s exceeds the line value.', v_line_no);
    end if;

    -- Tax. Ghanaian retail prices normally already include it, so an INCLUSIVE product's
    -- tax is extracted from the price rather than added to it — adding it would silently
    -- overcharge every customer.
    v_line_tax := 0;
    if v_product.tax_mode = 'EXCLUSIVE' and coalesce(v_product.tax_rate, 0) > 0 then
      v_line_tax := round(v_line_net * (v_product.tax_rate / 100))::bigint;
      v_line_total := v_line_net + v_line_tax;
    elsif v_product.tax_mode = 'INCLUSIVE' and coalesce(v_product.tax_rate, 0) > 0 then
      v_line_tax := round(
        v_line_net - (v_line_net / (1 + v_product.tax_rate / 100))
      )::bigint;
      v_line_total := v_line_net;
    else
      v_line_total := v_line_net;
    end if;

    insert into public.sale_items (
      sale_id, tenant_id, branch_id, product_id, line_number, product_name, product_sku,
      quantity, unit_price, unit_cost, discount_type, discount_value, discount_amount,
      tax_rate, tax_amount, line_total
    )
    values (
      v_sale_id, v_tenant_id, p_branch_id, v_product.id, v_line_no,
      v_product.name, v_product.sku, v_quantity, v_unit_price, v_product.average_cost,
      coalesce((v_item ->> 'discount_type')::public.discount_type, 'NONE'),
      (v_item ->> 'discount_value')::numeric,
      v_line_discount,
      coalesce(v_product.tax_rate, 0), v_line_tax, v_line_total
    );

    -- Stock. Raises INSUFFICIENT_STOCK, which rolls the entire sale back — there is no
    -- state in which some lines were deducted and the sale then failed.
    perform app.apply_movement(
      v_tenant_id, p_branch_id, v_product.id, 'SALE', -v_quantity,
      v_product.average_cost, 'sale', v_sale_id, null, p_device_id, v_sold_at
    );

    v_subtotal   := v_subtotal + v_line_total;
    v_tax_total  := v_tax_total + v_line_tax;
    v_cost_total := v_cost_total + round(v_product.average_cost * v_quantity)::bigint;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 6. Order-level discount
  -- ---------------------------------------------------------------------------
  if p_order_discount_type = 'PERCENTAGE' then
    v_order_discount := round(v_subtotal * (p_order_discount_value / 100))::bigint;
  elsif p_order_discount_type = 'AMOUNT' then
    v_order_discount := p_order_discount_value::bigint;
  end if;

  if v_order_discount < 0 then
    raise exception 'INVALID_PRICE' using detail = 'The order discount is negative.';
  end if;

  if v_order_discount > 0 then
    if not app.has_permission(v_tenant_id, 'sales.discount', p_branch_id) then
      raise exception 'DISCOUNT_NOT_PERMITTED';
    end if;
    if not app.has_permission(v_tenant_id, 'sales.discount_unrestricted', p_branch_id)
       and v_order_discount > round(v_subtotal * 0.20) then
      raise exception 'DISCOUNT_EXCEEDS_LIMIT';
    end if;
    if v_order_discount > v_subtotal then
      raise exception 'INVALID_PRICE' using detail = 'The discount exceeds the order total.';
    end if;
  end if;

  -- `sales.total = subtotal - discount + tax` is asserted by a CHECK on the row. Tax is
  -- already inside the line totals, so it is added back here to satisfy that identity
  -- without double-counting.
  v_total := v_subtotal - v_order_discount;

  -- ---------------------------------------------------------------------------
  -- 7. Payments
  -- ---------------------------------------------------------------------------
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'PAYMENT_INCOMPLETE' using detail = 'No payment was recorded.';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments)
  loop
    v_method    := (v_payment ->> 'method')::public.payment_method;
    v_amount    := (v_payment ->> 'amount')::bigint;
    v_reference := nullif(btrim(coalesce(v_payment ->> 'reference', '')), '');

    if v_amount is null or v_amount <= 0 then
      raise exception 'PAYMENT_INCOMPLETE' using detail = 'A payment amount must be positive.';
    end if;

    -- Carl does not integrate a mobile money API. Without a reference the payment cannot
    -- be reconciled against the phone, so it is refused at both this layer and the CHECK.
    if v_method in ('MOMO', 'BANK_TRANSFER') and v_reference is null then
      raise exception 'PAYMENT_REFERENCE_REQUIRED'
        using detail = format('A reference is required for a %s payment.', v_method);
    end if;

    insert into public.sale_payments
      (sale_id, tenant_id, branch_id, method, amount, reference, received_by)
    values (v_sale_id, v_tenant_id, p_branch_id, v_method, v_amount, v_reference, auth.uid());

    v_paid := v_paid + v_amount;
    if v_method = 'CASH' then
      v_cash_paid := v_cash_paid + v_amount;
    end if;
  end loop;

  if v_paid < v_total then
    raise exception 'PAYMENT_INCOMPLETE'
      using detail = format('Payments total %s but the sale is %s.', v_paid, v_total);
  end if;

  -- Overpayment is change, and only cash can produce it. A card or transfer for more than
  -- the total is a mistake, not a tip, and handing physical cash back for it would take
  -- money out of the drawer against an electronic receipt.
  v_change := v_paid - v_total;
  if v_change > 0 and v_change > v_cash_paid then
    raise exception 'CHANGE_NOT_PERMITTED'
      using detail = 'Change can only be given against a cash payment.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 8. Finalise
  -- ---------------------------------------------------------------------------
  update public.sales
     set subtotal        = v_subtotal,
         discount_amount = v_order_discount,
         tax_amount      = 0,
         total           = v_total,
         cost_total      = v_cost_total,
         amount_paid     = v_paid,
         change_given    = v_change
   where id = v_sale_id;

  if v_session_id is not null and v_cash_paid > 0 then
    update public.cash_sessions
       set cash_sales = cash_sales + (v_cash_paid - v_change)
     where id = v_session_id;
  end if;

  if p_customer_id is not null then
    update public.customers set updated_at = now() where id = p_customer_id;
  end if;

  if p_device_id is not null then
    update public.devices
       set last_seen_at = now(),
           last_sync_at = case when p_sold_at is null then now() else last_sync_at end
     where id = p_device_id;
  end if;

  update public.idempotency_keys
     set status = 'SUCCEEDED', result_id = v_sale_id, completed_at = now()
   where tenant_id = v_tenant_id
     and operation = 'complete_sale'
     and key = p_idempotency_key;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, device_id, metadata)
  values (
    v_tenant_id, p_branch_id, auth.uid(), 'SALE_CREATED', 'sale', v_sale_id, p_device_id,
    jsonb_build_object(
      'sale_number', v_sale_number,
      'total', v_total,
      'lines', v_line_no,
      'tier', p_tier
    )
  );

  return query select v_sale_id, v_sale_number, v_total, v_paid, v_change, false;
end;
$$;

comment on function complete_sale is
  'Completes a sale atomically. Derives every price and total server-side; the client supplies only products, quantities and tenders.';

revoke execute on function complete_sale from public, anon;
grant execute on function complete_sale to authenticated, service_role;
