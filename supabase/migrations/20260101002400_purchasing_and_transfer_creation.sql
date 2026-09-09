-- =============================================================================
-- 0024 · Creating purchases and stock transfers
--
-- The receiving half of both workflows already exists (0018). This adds the creating
-- half, which was reachable only by inserting rows directly — and a direct insert skips
-- the authorization and cross-branch checks that make the operation safe.
--
-- Both functions follow the same rule as every other mutation in Carl: the caller says
-- *what* they want to do, and the database decides whether they may and what it costs.
-- Neither accepts a tenant id; both derive it from the branch, which RLS has already
-- confined to the caller.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_purchase
--
-- Creates a purchase order in DRAFT. Stock does not move here — it moves when the goods
-- arrive, through receive_purchase(). Ordering something is not the same as having it,
-- and a system that conflates the two reports stock it does not hold.
-- -----------------------------------------------------------------------------

create or replace function create_purchase(
  p_branch_id           uuid,
  p_items               jsonb,
  p_supplier_id         uuid default null,
  p_supplier_invoice_no text default null,
  p_notes               text default null,
  p_expected_at         timestamptz default null
)
returns table (purchase_id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch      record;
  v_purchase_id uuid;
  v_reference   text;
  v_item        jsonb;
  v_line        smallint := 0;
  v_quantity    numeric;
  v_unit_cost   bigint;
  v_line_total  bigint;
  v_subtotal    bigint := 0;
  v_product     record;
begin
  select b.* into v_branch from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  if not app.has_permission(v_branch.tenant_id, 'purchases.create', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.can_access_branch(p_branch_id) then
    raise exception 'FORBIDDEN_BRANCH';
  end if;

  if not app.tenant_can_transact(v_branch.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'A purchase needs at least one line.';
  end if;

  -- A supplier belonging to another tenant would satisfy the foreign key while being a
  -- cross-tenant reference. Checked explicitly, as elsewhere.
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers s
    where s.id = p_supplier_id and s.tenant_id = v_branch.tenant_id
  ) then
    raise exception 'NOT_FOUND' using detail = 'Supplier not found.';
  end if;

  select 'PO-' || lpad((count(*) + 1)::text, 6, '0') into v_reference
  from public.purchases where tenant_id = v_branch.tenant_id;

  insert into public.purchases
    (tenant_id, branch_id, supplier_id, reference, supplier_invoice_no, status,
     notes, ordered_at, expected_at, created_by)
  values
    (v_branch.tenant_id, p_branch_id, p_supplier_id, v_reference, p_supplier_invoice_no,
     'ORDERED', p_notes, now(), p_expected_at, auth.uid())
  returning id into v_purchase_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_line := v_line + 1;
    v_quantity  := (v_item ->> 'quantity')::numeric;
    v_unit_cost := (v_item ->> 'unit_cost')::bigint;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'INVALID_QUANTITY'
        using detail = format('Line %s has an invalid quantity.', v_line);
    end if;
    if v_unit_cost is null or v_unit_cost < 0 then
      raise exception 'INVALID_PRICE'
        using detail = format('Line %s has an invalid cost.', v_line);
    end if;

    select p.* into v_product
    from public.products p
    where p.id = (v_item ->> 'product_id')::uuid and p.tenant_id = v_branch.tenant_id;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND'
        using detail = format('Line %s refers to a product that does not exist.', v_line);
    end if;

    v_line_total := round(v_quantity * v_unit_cost)::bigint;
    v_subtotal := v_subtotal + v_line_total;

    insert into public.purchase_items
      (purchase_id, tenant_id, product_id, line_number, quantity_ordered, unit_cost, line_total)
    values
      (v_purchase_id, v_branch.tenant_id, v_product.id, v_line, v_quantity, v_unit_cost, v_line_total);
  end loop;

  update public.purchases
     set subtotal = v_subtotal, total = v_subtotal
   where id = v_purchase_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_branch.tenant_id, p_branch_id, auth.uid(), 'PURCHASE_CREATED', 'purchase', v_purchase_id,
    jsonb_build_object('reference', v_reference, 'lines', v_line, 'total', v_subtotal)
  );

  return query select v_purchase_id, v_reference;
end;
$$;

revoke execute on function create_purchase(uuid, jsonb, uuid, text, text, timestamptz) from public, anon;
grant execute on function create_purchase(uuid, jsonb, uuid, text, text, timestamptz) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- create_stock_transfer
--
-- ## Why both branches are checked
--
-- A transfer touches two branches, and the caller must be entitled to move stock *out of*
-- the source. Checking only the tenant would let a Kumasi supervisor empty the Accra
-- shelves — every foreign key satisfied, every row in the right tenant, and stock gone
-- from a branch they have no authority over.
-- -----------------------------------------------------------------------------

create or replace function create_stock_transfer(
  p_from_branch_id uuid,
  p_to_branch_id   uuid,
  p_items          jsonb,
  p_notes          text default null
)
returns table (transfer_id uuid, reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from        record;
  v_to          record;
  v_transfer_id uuid;
  v_reference   text;
  v_item        jsonb;
  v_quantity    numeric;
  v_product     record;
  v_count       integer := 0;
begin
  select b.* into v_from from public.branches b where b.id = p_from_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Source branch not found.';
  end if;

  select b.* into v_to from public.branches b where b.id = p_to_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Destination branch not found.';
  end if;

  if p_from_branch_id = p_to_branch_id then
    raise exception 'VALIDATION_FAILED'
      using detail = 'A transfer must be between two different branches.';
  end if;

  -- Both branches must belong to the same business. Two independent foreign keys do not
  -- express this, and a mismatch would move stock between tenants.
  if v_from.tenant_id is distinct from v_to.tenant_id then
    raise exception 'CROSS_TENANT_REFERENCE'
      using detail = 'Those branches belong to different businesses.';
  end if;

  if not app.has_permission(v_from.tenant_id, 'inventory.transfer_create', p_from_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  -- Authority over the *source* is what matters: this is stock leaving a shelf.
  if not app.can_access_branch(p_from_branch_id) then
    raise exception 'FORBIDDEN_BRANCH'
      using detail = 'You cannot move stock out of that branch.';
  end if;

  if not app.tenant_can_transact(v_from.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION_FAILED' using detail = 'A transfer needs at least one line.';
  end if;

  select 'TR-' || lpad((count(*) + 1)::text, 6, '0') into v_reference
  from public.stock_transfers where tenant_id = v_from.tenant_id;

  insert into public.stock_transfers
    (tenant_id, reference, from_branch_id, to_branch_id, status, notes, requested_by, requested_at)
  values
    (v_from.tenant_id, v_reference, p_from_branch_id, p_to_branch_id, 'REQUESTED',
     p_notes, auth.uid(), now())
  returning id into v_transfer_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_quantity := (v_item ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'INVALID_QUANTITY';
    end if;

    select p.* into v_product
    from public.products p
    where p.id = (v_item ->> 'product_id')::uuid and p.tenant_id = v_from.tenant_id;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;

    insert into public.stock_transfer_items
      (transfer_id, tenant_id, product_id, quantity_requested, unit_cost)
    values
      (v_transfer_id, v_from.tenant_id, v_product.id, v_quantity, v_product.average_cost);

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_from.tenant_id, p_from_branch_id, auth.uid(),
    'TRANSFER_CREATED', 'stock_transfer', v_transfer_id,
    jsonb_build_object('reference', v_reference, 'to_branch_id', p_to_branch_id, 'lines', v_count)
  );

  return query select v_transfer_id, v_reference;
end;
$$;

revoke execute on function create_stock_transfer(uuid, uuid, jsonb, text) from public, anon;
grant execute on function create_stock_transfer(uuid, uuid, jsonb, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- cancel_stock_transfer
--
-- Cancelling before dispatch is bookkeeping. Cancelling after dispatch is not offered:
-- the stock has physically left, and pretending otherwise would leave it counted at a
-- branch that does not have it. Such a transfer is received (possibly with a shortfall)
-- or investigated.
-- -----------------------------------------------------------------------------

create or replace function cancel_stock_transfer(p_transfer_id uuid, p_reason text)
returns table (cancelled_transfer_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer record;
begin
  select t.* into v_transfer from public.stock_transfers t where t.id = p_transfer_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Transfer not found.';
  end if;

  if not app.has_permission(v_transfer.tenant_id, 'inventory.transfer_create', v_transfer.from_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_transfer.status not in ('DRAFT', 'REQUESTED', 'APPROVED') then
    raise exception 'STOCK_TRANSFER_INVALID_STATE'
      using detail = 'Stock has already left the source branch. Receive the transfer instead.';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'VALIDATION_FAILED' using detail = 'A reason is required to cancel a transfer.';
  end if;

  update public.stock_transfers
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = p_reason
   where id = p_transfer_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_transfer.tenant_id, v_transfer.from_branch_id, auth.uid(),
    'TRANSFER_CANCELLED', 'stock_transfer', p_transfer_id,
    jsonb_build_object('reason', p_reason)
  );

  return query select p_transfer_id;
end;
$$;

revoke execute on function cancel_stock_transfer(uuid, text) from public, anon;
grant execute on function cancel_stock_transfer(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- upsert_product
--
-- Creating or editing a product together with its prices, in one transaction.
--
-- Doing this as separate client calls leaves a window where a product exists with no
-- price — and a product with no price cannot be sold, so the failure surfaces at the till
-- rather than in the form that caused it.
-- -----------------------------------------------------------------------------

-- Required parameters come first so `p_product_id` can carry a default. PostgreSQL does
-- not allow a defaulted parameter before a non-defaulted one, and without a default the
-- generated client type marks it non-nullable — which is wrong, since omitting it is
-- exactly how a product is created rather than edited.
create or replace function upsert_product(
  p_branch_id        uuid,
  p_name             text,
  p_sku              text,
  p_retail_price     bigint,
  p_product_id       uuid default null,
  p_category_id      uuid default null,
  p_description      text default null,
  p_unit             text default 'unit',
  p_allow_fractional boolean default false,
  p_is_stock_tracked boolean default true,
  p_is_active        boolean default true,
  p_wholesale_price  bigint default null,
  p_cost_price       bigint default 0,
  p_reorder_level    numeric default 0,
  p_min_stock        numeric default 0,
  p_tax_mode         tax_mode default 'INCLUSIVE',
  p_tax_rate         numeric default null,
  p_barcode          text default null,
  p_image_url        text default null
)
returns table (product_id uuid, was_created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_id        uuid;
  v_created   boolean := false;
begin
  select b.tenant_id into v_tenant_id from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  if not app.tenant_can_transact(v_tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if p_product_id is null then
    if not app.has_permission(v_tenant_id, 'products.create') then
      raise exception 'PERMISSION_DENIED';
    end if;

    insert into public.products
      (tenant_id, category_id, name, sku, description, unit, allow_fractional,
       is_stock_tracked, is_active, average_cost, last_cost, reorder_level, min_stock,
       tax_mode, tax_rate, image_url, created_by)
    values
      (v_tenant_id, p_category_id, p_name, upper(p_sku), p_description, p_unit,
       p_allow_fractional, p_is_stock_tracked, p_is_active, p_cost_price, p_cost_price,
       p_reorder_level, p_min_stock, p_tax_mode,
       case when p_tax_mode = 'EXEMPT' then null else p_tax_rate end,
       p_image_url, auth.uid())
    returning id into v_id;

    v_created := true;
  else
    if not app.has_permission(v_tenant_id, 'products.update') then
      raise exception 'PERMISSION_DENIED';
    end if;

    -- Scoped by tenant as well as id: an id from another business must not be editable,
    -- and RLS does not apply to this SECURITY DEFINER function's own writes.
    update public.products
       set category_id      = p_category_id,
           name             = p_name,
           sku              = upper(p_sku),
           description      = p_description,
           unit             = p_unit,
           allow_fractional = p_allow_fractional,
           is_stock_tracked = p_is_stock_tracked,
           is_active        = p_is_active,
           reorder_level    = p_reorder_level,
           min_stock        = p_min_stock,
           tax_mode         = p_tax_mode,
           tax_rate         = case when p_tax_mode = 'EXEMPT' then null else p_tax_rate end,
           image_url        = p_image_url
     where id = p_product_id and tenant_id = v_tenant_id
    returning id into v_id;

    if v_id is null then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;

    -- Cost is maintained by receive_purchase() as a weighted average once stock starts
    -- moving. It is only settable here while the product has never been purchased,
    -- otherwise editing a product would silently restate historical margins.
    if p_cost_price is not null and not exists (
      select 1 from public.inventory_movements m
      where m.product_id = v_id and m.movement_type = 'PURCHASE'
    ) then
      update public.products set average_cost = p_cost_price, last_cost = p_cost_price
       where id = v_id;
    end if;
  end if;

  -- Prices go through set_product_price so they are windowed: changing one closes the old
  -- row rather than overwriting it, and a refund can still be valued at what was charged.
  if p_retail_price is not null then
    perform public.set_product_price(v_id, p_retail_price, 'RETAIL', null, 0);
  end if;
  if p_wholesale_price is not null then
    perform public.set_product_price(v_id, p_wholesale_price, 'WHOLESALE', null, 0);
  end if;

  if p_barcode is not null and length(btrim(p_barcode)) > 0 then
    insert into public.product_barcodes (tenant_id, product_id, barcode, is_primary)
    values (v_tenant_id, v_id, btrim(p_barcode), true)
    on conflict (tenant_id, barcode) do nothing;
  end if;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_tenant_id, p_branch_id, auth.uid(),
    case when v_created then 'PRODUCT_CREATED' else 'PRODUCT_UPDATED' end,
    'product', v_id,
    jsonb_build_object('name', p_name, 'sku', upper(p_sku), 'retail_price', p_retail_price)
  );

  return query select v_id, v_created;
end;
$$;

revoke execute on function upsert_product from public, anon;
grant execute on function upsert_product to authenticated, service_role;
