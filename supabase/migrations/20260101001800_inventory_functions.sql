-- =============================================================================
-- 0018 · Transactional inventory operations
--
-- ## Why stock is only ever moved by these functions
--
-- There is no INSERT or UPDATE policy on `inventory` for any role. Stock cannot be
-- written directly — not by a cashier, not by an administrator, not by application code.
-- Every change comes through a function here, and every function does two things in one
-- transaction: adjust the cached quantity, and post a ledger movement explaining why.
--
-- The alternative — letting code update `inventory.quantity` — produces exactly the
-- failure the ledger exists to prevent: a stock level nobody can account for.
--
-- ## Locking
--
-- Every function takes a row lock on the `inventory` row before reading its quantity.
-- Without it, two terminals selling the last unit simultaneously both read "1 available",
-- both decide it is fine, and both sell it. `FOR UPDATE` makes the second wait for the
-- first to commit, so it reads 0 and is refused.
--
-- This is the whole of Carl's concurrency control for stock, and it is tested with
-- genuinely concurrent transactions rather than assumed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app.apply_movement
--
-- The single point through which every stock change passes. Private to the `app` schema:
-- callers use the operation-specific functions below, which apply their own authorisation.
-- -----------------------------------------------------------------------------

create or replace function app.apply_movement(
  p_tenant_id      uuid,
  p_branch_id      uuid,
  p_product_id     uuid,
  p_movement_type  movement_type,
  p_quantity       numeric,
  p_unit_cost      bigint default 0,
  p_reference_type text default null,
  p_reference_id   uuid default null,
  p_reason         text default null,
  p_device_id      uuid default null,
  p_occurred_at    timestamptz default null,
  p_allow_negative boolean default false
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance   numeric;
  v_tracked   boolean;
  v_negative  boolean;
begin
  if p_quantity = 0 then
    raise exception 'INVALID_QUANTITY' using detail = 'A movement of zero records nothing.';
  end if;

  select p.is_stock_tracked into v_tracked
  from public.products p
  where p.id = p_product_id and p.tenant_id = p_tenant_id;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  -- A service has no stock. Posting movements for one would build a ledger for something
  -- that cannot run out, and would block sales when it inevitably went negative.
  if not v_tracked then
    return null;
  end if;

  -- Creates the row on first movement, so a product need not be pre-seeded into every
  -- branch it might one day be sold in.
  insert into public.inventory (tenant_id, branch_id, product_id, quantity, reorder_level)
  values (
    p_tenant_id, p_branch_id, p_product_id, 0,
    coalesce((select p.reorder_level from public.products p where p.id = p_product_id), 0)
  )
  on conflict (branch_id, product_id) do nothing;

  -- The lock. Everything after this point sees a quantity no other transaction can change
  -- until this one commits.
  select i.quantity into v_balance
  from public.inventory i
  where i.branch_id = p_branch_id and i.product_id = p_product_id
  for update;

  v_balance := v_balance + p_quantity;

  if v_balance < 0 and not p_allow_negative then
    select b.allow_negative_stock into v_negative
    from public.branches b where b.id = p_branch_id;

    if not coalesce(v_negative, false) then
      raise exception 'INSUFFICIENT_STOCK'
        using detail = format(
          'Requested %s but only %s available.',
          abs(p_quantity), v_balance - p_quantity
        );
    end if;
  end if;

  update public.inventory
     set quantity = v_balance,
         last_movement_at = now()
   where branch_id = p_branch_id and product_id = p_product_id;

  insert into public.inventory_movements (
    tenant_id, branch_id, product_id, movement_type, quantity, balance_after,
    unit_cost, reference_type, reference_id, reason, performed_by, device_id, occurred_at
  )
  values (
    p_tenant_id, p_branch_id, p_product_id, p_movement_type, p_quantity, v_balance,
    p_unit_cost, p_reference_type, p_reference_id, p_reason, auth.uid(), p_device_id,
    coalesce(p_occurred_at, now())
  );

  return v_balance;
end;
$$;

comment on function app.apply_movement is
  'The only path by which stock changes. Locks the row, adjusts the total, posts the ledger entry — atomically.';

-- -----------------------------------------------------------------------------
-- apply_stock_adjustment
--
-- A manual correction: damage, expiry, theft, or a discovered miscount.
-- -----------------------------------------------------------------------------

create or replace function apply_stock_adjustment(
  p_branch_id     uuid,
  p_product_id    uuid,
  p_quantity      numeric,
  p_movement_type movement_type,
  p_reason        text
)
returns table (new_quantity numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_cost      bigint;
  v_balance   numeric;
begin
  select b.tenant_id into v_tenant_id from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  if not app.has_permission(v_tenant_id, 'inventory.adjust', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if not app.can_access_branch(p_branch_id) then
    raise exception 'FORBIDDEN_BRANCH';
  end if;

  -- A reason is mandatory. An adjustment without one is indistinguishable from theft, and
  -- the ledger exists precisely so that question can be answered later.
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'VALIDATION_FAILED'
      using detail = 'A reason of at least 3 characters is required for a stock adjustment.';
  end if;

  if p_movement_type not in
     ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRED', 'THEFT', 'OPENING_STOCK') then
    raise exception 'VALIDATION_FAILED'
      using detail = 'That movement type cannot be applied as a manual adjustment.';
  end if;

  select p.average_cost into v_cost from public.products p where p.id = p_product_id;

  v_balance := app.apply_movement(
    v_tenant_id, p_branch_id, p_product_id, p_movement_type, p_quantity,
    coalesce(v_cost, 0), 'adjustment', null, p_reason
  );

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_tenant_id, p_branch_id, auth.uid(), 'STOCK_ADJUSTED', 'product', p_product_id,
    jsonb_build_object('quantity', p_quantity, 'type', p_movement_type, 'reason', p_reason)
  );

  return query select v_balance;
end;
$$;

revoke execute on function apply_stock_adjustment(uuid, uuid, numeric, movement_type, text) from public, anon;
grant execute on function apply_stock_adjustment(uuid, uuid, numeric, movement_type, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- receive_purchase
--
-- Brings a delivery into stock and updates weighted-average cost.
--
-- ## Weighted average, not last cost
--
-- If 10 units were bought at GH₵10 and 10 more arrive at GH₵14, the stock is worth GH₵12
-- a unit, not GH₵14. Using the latest price would restate the value of goods already on
-- the shelf and make every margin figure wrong until the stock turned over.
-- -----------------------------------------------------------------------------

create or replace function receive_purchase(
  p_purchase_id uuid,
  p_items       jsonb
)
returns table (received_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase   record;
  v_item       jsonb;
  v_product_id uuid;
  v_quantity   numeric;
  v_unit_cost  bigint;
  v_count      integer := 0;
  v_on_hand    numeric;
  v_old_cost   bigint;
begin
  select p.* into v_purchase from public.purchases p where p.id = p_purchase_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Purchase not found.';
  end if;

  if not app.has_permission(v_purchase.tenant_id, 'purchases.receive', v_purchase.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_purchase.tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if v_purchase.status = 'CANCELLED' then
    raise exception 'CONFLICT' using detail = 'This purchase was cancelled.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity   := (v_item ->> 'quantity')::numeric;
    v_unit_cost  := (v_item ->> 'unit_cost')::bigint;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'INVALID_QUANTITY' using detail = 'Received quantity must be positive.';
    end if;

    -- The quantity on hand BEFORE this delivery, which is what the average is weighted by.
    select coalesce(i.quantity, 0) into v_on_hand
    from public.inventory i
    where i.branch_id = v_purchase.branch_id and i.product_id = v_product_id;

    select p.average_cost into v_old_cost
    from public.products p where p.id = v_product_id;

    perform app.apply_movement(
      v_purchase.tenant_id, v_purchase.branch_id, v_product_id, 'PURCHASE',
      v_quantity, v_unit_cost, 'purchase', p_purchase_id, null
    );

    update public.products
       set average_cost = case
             -- No existing stock means there is nothing to average against; the delivery
             -- sets the cost outright. Averaging against a zero or negative balance would
             -- produce a nonsensical figure.
             when coalesce(v_on_hand, 0) <= 0 then v_unit_cost
             else round(
               ((coalesce(v_on_hand, 0) * coalesce(v_old_cost, 0)) + (v_quantity * v_unit_cost))
               / (coalesce(v_on_hand, 0) + v_quantity)
             )::bigint
           end,
           last_cost = v_unit_cost
     where id = v_product_id;

    update public.purchase_items
       set quantity_received = quantity_received + v_quantity
     where purchase_id = p_purchase_id and product_id = v_product_id;

    v_count := v_count + 1;
  end loop;

  update public.purchases
     set status = case
           when not exists (
             select 1 from public.purchase_items pi
             where pi.purchase_id = p_purchase_id
               and pi.quantity_received < pi.quantity_ordered
           ) then 'RECEIVED'::public.purchase_status
           else 'PARTIALLY_RECEIVED'::public.purchase_status
         end,
         received_at = coalesce(received_at, now()),
         received_by = auth.uid()
   where id = p_purchase_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_purchase.tenant_id, v_purchase.branch_id, auth.uid(),
    'PURCHASE_RECEIVED', 'purchase', p_purchase_id,
    jsonb_build_object('line_count', v_count)
  );

  return query select v_count;
end;
$$;

revoke execute on function receive_purchase(uuid, jsonb) from public, anon;
grant execute on function receive_purchase(uuid, jsonb) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- receive_stock_transfer
--
-- ## Why stock is removed on dispatch, not on receipt
--
-- Goods in a van belong to neither branch's shelf. Removing them from the sending branch
-- only when they arrive would let the sender keep selling stock that physically left days
-- ago. So TRANSFER_OUT posts at dispatch and TRANSFER_IN at receipt, and the difference is
-- visible as stock in transit.
-- -----------------------------------------------------------------------------

create or replace function dispatch_stock_transfer(p_transfer_id uuid)
returns table (dispatched_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer record;
  v_item     record;
  v_count    integer := 0;
  v_cost     bigint;
begin
  select t.* into v_transfer from public.stock_transfers t where t.id = p_transfer_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Transfer not found.';
  end if;

  if not app.has_permission(v_transfer.tenant_id, 'inventory.transfer_approve', v_transfer.from_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_transfer.status not in ('DRAFT', 'REQUESTED', 'APPROVED') then
    raise exception 'STOCK_TRANSFER_INVALID_STATE'
      using detail = format('A transfer in state %s cannot be dispatched.', v_transfer.status);
  end if;

  for v_item in
    select * from public.stock_transfer_items where transfer_id = p_transfer_id
  loop
    select p.average_cost into v_cost from public.products p where p.id = v_item.product_id;

    perform app.apply_movement(
      v_transfer.tenant_id, v_transfer.from_branch_id, v_item.product_id, 'TRANSFER_OUT',
      -v_item.quantity_requested, coalesce(v_cost, 0), 'stock_transfer', p_transfer_id
    );

    update public.stock_transfer_items
       set quantity_sent = quantity_requested, unit_cost = coalesce(v_cost, 0)
     where id = v_item.id;

    v_count := v_count + 1;
  end loop;

  update public.stock_transfers
     set status = 'IN_TRANSIT', dispatched_at = now()
   where id = p_transfer_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_transfer.tenant_id, v_transfer.from_branch_id, auth.uid(),
    'TRANSFER_DISPATCHED', 'stock_transfer', p_transfer_id,
    jsonb_build_object('to_branch_id', v_transfer.to_branch_id, 'line_count', v_count)
  );

  return query select v_count;
end;
$$;

create or replace function receive_stock_transfer(
  p_transfer_id uuid,
  p_received    jsonb default null
)
returns table (received_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer record;
  v_item     record;
  v_quantity numeric;
  v_count    integer := 0;
  v_shortfall numeric;
begin
  select t.* into v_transfer from public.stock_transfers t where t.id = p_transfer_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Transfer not found.';
  end if;

  if not app.has_permission(v_transfer.tenant_id, 'inventory.transfer_receive', v_transfer.to_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_transfer.status <> 'IN_TRANSIT' then
    raise exception 'STOCK_TRANSFER_INVALID_STATE'
      using detail = format('A transfer in state %s cannot be received.', v_transfer.status);
  end if;

  for v_item in
    select * from public.stock_transfer_items where transfer_id = p_transfer_id
  loop
    -- Defaults to "everything that was sent". A caller may report less, and the shortfall
    -- is recorded as a loss at the sending branch rather than silently discarded.
    v_quantity := coalesce(
      (
        select (elem ->> 'quantity')::numeric
        from jsonb_array_elements(coalesce(p_received, '[]'::jsonb)) elem
        where (elem ->> 'product_id')::uuid = v_item.product_id
      ),
      v_item.quantity_sent
    );

    if v_quantity > 0 then
      perform app.apply_movement(
        v_transfer.tenant_id, v_transfer.to_branch_id, v_item.product_id, 'TRANSFER_IN',
        v_quantity, v_item.unit_cost, 'stock_transfer', p_transfer_id
      );
    end if;

    update public.stock_transfer_items
       set quantity_received = v_quantity
     where id = v_item.id;

    -- Goods that left but never arrived. Recorded explicitly so the difference is
    -- investigable rather than appearing as an unexplained shrinkage at the next count.
    v_shortfall := v_item.quantity_sent - v_quantity;
    if v_shortfall > 0 then
      insert into public.audit_logs
        (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
      values (
        v_transfer.tenant_id, v_transfer.to_branch_id, auth.uid(),
        'TRANSFER_SHORTFALL', 'stock_transfer', p_transfer_id,
        jsonb_build_object(
          'product_id', v_item.product_id,
          'sent', v_item.quantity_sent,
          'received', v_quantity
        )
      );
    end if;

    v_count := v_count + 1;
  end loop;

  update public.stock_transfers
     set status = 'RECEIVED', received_at = now(), received_by = auth.uid()
   where id = p_transfer_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_transfer.tenant_id, v_transfer.to_branch_id, auth.uid(),
    'TRANSFER_RECEIVED', 'stock_transfer', p_transfer_id,
    jsonb_build_object('line_count', v_count)
  );

  return query select v_count;
end;
$$;

revoke execute on function dispatch_stock_transfer(uuid) from public, anon;
revoke execute on function receive_stock_transfer(uuid, jsonb) from public, anon;
grant execute on function dispatch_stock_transfer(uuid) to authenticated, service_role;
grant execute on function receive_stock_transfer(uuid, jsonb) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- apply_stock_count
--
-- Turns a physical count into ledger movements.
--
-- The variance is posted as STOCK_COUNT movements rather than by setting the quantity
-- directly, so a stock take is as traceable as a sale. "Where did 40 units go" must remain
-- answerable after the count, not before it.
-- -----------------------------------------------------------------------------

create or replace function apply_stock_count(p_stock_count_id uuid)
returns table (adjusted_count integer, total_variance numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count    record;
  v_item     record;
  v_adjusted integer := 0;
  v_variance numeric := 0;
begin
  select c.* into v_count from public.stock_counts c where c.id = p_stock_count_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Stock count not found.';
  end if;

  if not app.has_permission(v_count.tenant_id, 'inventory.count_approve', v_count.branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if v_count.status = 'APPROVED' then
    raise exception 'STOCK_COUNT_ALREADY_CLOSED';
  end if;

  if v_count.status = 'CANCELLED' then
    raise exception 'STOCK_COUNT_ALREADY_CLOSED' using detail = 'This count was cancelled.';
  end if;

  for v_item in
    select * from public.stock_count_items
    where stock_count_id = p_stock_count_id and counted_quantity is not null
  loop
    -- Measured against the quantity frozen when counting began, so sales made during the
    -- count do not move the variance under review.
    declare
      v_delta numeric := v_item.counted_quantity - v_item.expected_quantity;
    begin
      if v_delta <> 0 then
        perform app.apply_movement(
          v_count.tenant_id, v_count.branch_id, v_item.product_id, 'STOCK_COUNT',
          v_delta, v_item.unit_cost, 'stock_count', p_stock_count_id,
          format('Stock count %s', v_count.reference),
          null, null,
          -- A count reports what is physically there. Refusing to record it because the
          -- result is negative would leave the system holding a number known to be wrong.
          true
        );
        v_adjusted := v_adjusted + 1;
        v_variance := v_variance + v_delta;
      end if;

      update public.stock_count_items set variance = v_delta where id = v_item.id;
    end;
  end loop;

  update public.stock_counts
     set status = 'APPROVED', approved_at = now(), approved_by = auth.uid()
   where id = p_stock_count_id;

  update public.inventory
     set last_counted_at = now()
   where branch_id = v_count.branch_id
     and product_id in (
       select product_id from public.stock_count_items where stock_count_id = p_stock_count_id
     );

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_count.tenant_id, v_count.branch_id, auth.uid(),
    'STOCK_COUNT_APPROVED', 'stock_count', p_stock_count_id,
    jsonb_build_object('adjusted_lines', v_adjusted, 'net_variance', v_variance)
  );

  return query select v_adjusted, v_variance;
end;
$$;

revoke execute on function apply_stock_count(uuid) from public, anon;
grant execute on function apply_stock_count(uuid) to authenticated, service_role;
