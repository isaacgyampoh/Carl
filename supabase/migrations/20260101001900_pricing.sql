-- =============================================================================
-- 0019 · Price resolution
--
-- ## The rule this file exists to enforce
--
-- A client never sends a price. It sends a product and a quantity, and this decides what
-- that costs. A price arriving in a request body is not validated — nothing reads it.
--
-- Without this, a POS is trivially defeated: intercept the checkout request, change the
-- price to 1 pesewa, and the sale completes at that price with a correct-looking receipt.
-- Validating a submitted price against the catalogue would be equivalent to this function
-- but with an extra opportunity to get the comparison wrong.
--
-- ## Resolution order
--
-- Prices are windowed and may be scoped to a branch and to a quantity break. For a given
-- product, tier, branch and quantity, the winner is:
--
--   1. a live branch-specific price, if one exists          (an airport site charges more)
--   2. otherwise the live tenant-wide price
--   3. within that, the highest quantity break the line qualifies for
--
-- ## Historical lookup
--
-- `p_at` defaults to now but may be any instant, so a refund three months later is valued
-- at the price actually charged rather than today's.
-- =============================================================================

create or replace function app.resolve_price(
  p_product_id uuid,
  p_branch_id  uuid,
  p_tier       price_tier default 'RETAIL',
  p_quantity   numeric default 1,
  p_at         timestamptz default null
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select pp.amount
  from public.product_prices pp
  where pp.product_id = p_product_id
    and pp.tier = p_tier
    and (pp.branch_id is null or pp.branch_id = p_branch_id)
    and pp.min_quantity <= p_quantity
    and pp.effective_from <= coalesce(p_at, now())
    and (pp.effective_to is null or pp.effective_to > coalesce(p_at, now()))
  order by
    -- A branch-specific price beats the tenant-wide default.
    (pp.branch_id is null),
    -- Then the largest quantity break this line qualifies for.
    pp.min_quantity desc,
    -- Deterministic tie-break, so two prices created in the same transaction cannot make
    -- the resolved price depend on physical row order.
    pp.effective_from desc,
    pp.id
  limit 1
$$;

comment on function app.resolve_price is
  'The only source of a selling price. Branch overrides tenant-wide; highest qualifying quantity break wins.';

-- -----------------------------------------------------------------------------
-- resolve_sale_price
--
-- The client-facing lookup, used to price a cart before checkout.
--
-- It returns the same figure `complete_sale()` will compute, but the displayed price is a
-- courtesy: the sale re-resolves at completion. A price that changes between the cashier
-- reading the screen and tapping Complete is charged at the resolved rate, not the
-- displayed one.
-- -----------------------------------------------------------------------------

create or replace function resolve_sale_price(
  p_product_id uuid,
  p_branch_id  uuid,
  p_tier       price_tier default 'RETAIL',
  p_quantity   numeric default 1
)
returns table (
  product_id   uuid,
  unit_price   bigint,
  tax_mode     tax_mode,
  tax_rate     numeric,
  is_active    boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_product   record;
  v_price     bigint;
begin
  select b.tenant_id into v_tenant_id from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  -- Reading a price is part of selling, so products.view is the gate.
  if not app.can_read(v_tenant_id, 'products.view', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select p.* into v_product
  from public.products p
  where p.id = p_product_id and p.tenant_id = v_tenant_id;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  v_price := app.resolve_price(p_product_id, p_branch_id, p_tier, p_quantity, null);

  if v_price is null then
    -- Deliberately distinct from PRODUCT_NOT_FOUND: a product with no price is a
    -- configuration gap someone can fix, and saying so saves a support call.
    raise exception 'PRICE_NOT_CONFIGURED'
      using detail = format('No %s price is configured for this product.', p_tier);
  end if;

  return query
    select v_product.id, v_price, v_product.tax_mode,
           coalesce(v_product.tax_rate, 0)::numeric, v_product.is_active;
end;
$$;

revoke execute on function resolve_sale_price(uuid, uuid, price_tier, numeric) from public, anon;
grant execute on function resolve_sale_price(uuid, uuid, price_tier, numeric) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- set_product_price
--
-- Changing a price closes the current row and opens a new one, rather than updating in
-- place. History survives, so a refund can be valued at what was actually charged and a
-- price change is visible in the audit trail.
-- -----------------------------------------------------------------------------

create or replace function set_product_price(
  p_product_id   uuid,
  p_amount       bigint,
  p_tier         price_tier default 'RETAIL',
  p_branch_id    uuid default null,
  p_min_quantity numeric default 0
)
returns table (price_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_price_id  uuid;
begin
  select p.tenant_id into v_tenant_id from public.products p where p.id = p_product_id;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  -- Setting a price is a stronger permission than editing a product: someone who can do
  -- this can sell to themselves at any price they choose.
  if not app.has_permission(v_tenant_id, 'products.manage_pricing', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if not app.tenant_can_transact(v_tenant_id) then
    raise exception 'TENANT_SUSPENDED';
  end if;

  if p_amount < 0 then
    raise exception 'INVALID_PRICE' using detail = 'A price cannot be negative.';
  end if;

  -- Close whatever is currently in force for this exact scope. The partial unique indexes
  -- would reject the insert otherwise, which is the database refusing to hold two live
  -- prices for the same thing.
  update public.product_prices
     set effective_to = now()
   where product_id = p_product_id
     and tier = p_tier
     and min_quantity = p_min_quantity
     and effective_to is null
     and branch_id is not distinct from p_branch_id;

  insert into public.product_prices
    (tenant_id, product_id, branch_id, tier, amount, min_quantity, created_by)
  values (v_tenant_id, p_product_id, p_branch_id, p_tier, p_amount, p_min_quantity, auth.uid())
  returning id into v_price_id;

  insert into public.audit_logs
    (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_tenant_id, p_branch_id, auth.uid(), 'PRICE_CHANGED', 'product', p_product_id,
    jsonb_build_object('tier', p_tier, 'amount', p_amount, 'min_quantity', p_min_quantity)
  );

  return query select v_price_id;
end;
$$;

revoke execute on function set_product_price(uuid, bigint, price_tier, uuid, numeric) from public, anon;
grant execute on function set_product_price(uuid, bigint, price_tier, uuid, numeric) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- search_products
--
-- The POS lookup. Matches on name, SKU and barcode in one indexed query.
--
-- A barcode match is returned first and alone where possible: a scan is unambiguous, and
-- making the cashier choose from a list after scanning defeats the point of the scanner.
-- -----------------------------------------------------------------------------

create or replace function search_products(
  p_branch_id uuid,
  p_query     text,
  p_tier      price_tier default 'RETAIL',
  p_limit     integer default 20
)
returns table (
  product_id   uuid,
  name         text,
  sku          text,
  unit         text,
  unit_price   bigint,
  quantity     numeric,
  is_exact     boolean,
  pack_size    numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_term      text := btrim(coalesce(p_query, ''));
begin
  select b.tenant_id into v_tenant_id from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'Branch not found.';
  end if;

  if not app.can_read(v_tenant_id, 'products.view', p_branch_id) then
    raise exception 'PERMISSION_DENIED';
  end if;

  if length(v_term) = 0 then
    return;
  end if;

  return query
  with barcode_hit as (
    select pb.product_id, pb.pack_size
    from public.product_barcodes pb
    where pb.tenant_id = v_tenant_id and pb.barcode = v_term
    limit 1
  ),
  candidates as (
    -- An exact barcode match short-circuits everything else.
    select b.product_id, true as exact, b.pack_size, 0 as rank
    from barcode_hit b

    union all

    select p.id, false, 1::numeric,
           -- Ordered by trigram similarity so a typo still surfaces the right product.
           -- An exact SKU match ranks above a fuzzy name match.
           case when upper(p.sku) = upper(v_term) then 1 else 2 end
    from public.products p
    where p.tenant_id = v_tenant_id
      and p.is_active
      and not exists (select 1 from barcode_hit)
      and (
        p.name ilike '%' || v_term || '%'
        or p.sku ilike v_term || '%'
        or extensions.similarity(p.name, v_term) > 0.25
      )
  )
  select
    c.product_id,
    p.name::text,
    p.sku,
    p.unit,
    app.resolve_price(c.product_id, p_branch_id, p_tier, c.pack_size, null),
    coalesce(i.quantity, 0),
    c.exact,
    c.pack_size
  from candidates c
  join public.products p on p.id = c.product_id
  left join public.inventory i
    on i.product_id = c.product_id and i.branch_id = p_branch_id
  order by c.rank, extensions.similarity(p.name, v_term) desc, p.name
  limit least(greatest(p_limit, 1), 50);
end;
$$;

comment on function search_products is
  'POS lookup across name, SKU and barcode. An exact barcode match wins outright so a scan needs no further choice.';

revoke execute on function search_products(uuid, text, price_tier, integer) from public, anon;
grant execute on function search_products(uuid, text, price_tier, integer) to authenticated, service_role;
