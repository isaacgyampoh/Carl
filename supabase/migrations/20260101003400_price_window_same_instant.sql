-- =============================================================================
-- 0034 · Changing a price twice in the same instant
--
-- `set_product_price` closed the outgoing price with `effective_to = now()`. When the same
-- price was set twice inside one clock tick -- a shopkeeper correcting a typo straight
-- away -- the outgoing row's `effective_to` equalled its own `effective_from`, and the
-- window constraint rejected it:
--
--     new row for relation "product_prices" violates check constraint
--     "product_prices_window_ordered"
--
-- The person saw a raw constraint violation and the price change was lost.
--
-- ## What is NOT changed
--
-- The constraint stays as it is. A zero-length window is a genuinely meaningless row:
-- "what did this cost at 14:32:07.1234" would have two answers, and the price history is
-- what a dispute with a customer gets settled from.
--
-- The function below is the existing one with a single expression changed. Nothing else --
-- signature, return type, permissions, audit -- is touched.
--
-- Found by a property test that failed roughly one run in three: intermittent enough to be
-- dismissed as a glitch, which is exactly how it would have reached a shop.
-- =============================================================================

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
     -- `greatest(now(), effective_from + 1 microsecond)` rather than plain `now()`: two
     -- price changes inside one clock tick would otherwise close a row at the instant it
     -- opened, which product_prices_window_ordered refuses. The partial unique indexes
     -- still do the real work of preventing two live prices; this only keeps the closed
     -- window ordered.
     set effective_to = greatest(now(), effective_from + interval '1 microsecond')
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

