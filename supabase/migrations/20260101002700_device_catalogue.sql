-- =============================================================================
-- 0027 · device_catalogue
--
-- What a terminal downloads so it can sell without a connection.
--
-- ## Why this is a database function and not a set of table reads
--
-- A terminal has no user session. It authenticates as itself, with the secret issued at
-- activation, and `app.authorize_device` is the only thing that establishes who it is.
-- Reading the tables directly would mean either giving terminals a user session (a shared
-- login on a shop floor, which is how a till becomes a way into the whole business) or
-- relaxing RLS. Neither is acceptable, so the download is one authorised function.
--
-- ## What is deliberately not returned
--
--   * `average_cost` and `last_cost` — margin data. The till never needs it, and a stolen
--     laptop should not reveal what the business pays its suppliers. `products.view_cost`
--     exists as a permission precisely because cost is not general information.
--   * Customer balances and credit limits — a debt list is not needed to ring up a sale.
--   * Any other branch's stock, any other tenant's anything.
--
-- ## Incremental
--
-- `p_since` returns only what changed, so a terminal that syncs hourly transfers almost
-- nothing. Passing NULL returns everything, which is what a freshly activated till does.
-- Deletions are returned separately as ids, because a product that is no longer sellable
-- must disappear from a till that only ever receives additions.
-- =============================================================================

create or replace function device_catalogue(
  p_device_id     uuid,
  p_device_secret text,
  p_pepper        text,
  p_since         timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device    record;
  v_result    jsonb;
  v_now       timestamptz := now();
begin
  perform app.authorize_device(p_device_id, p_device_secret, p_pepper);

  select d.tenant_id, d.branch_id into v_device
    from public.devices d
   where d.id = p_device_id;

  update public.devices set last_seen_at = v_now where id = p_device_id;

  select jsonb_build_object(
    -- Stamped by the server, not the terminal. A till with a wrong clock must not be able
    -- to talk itself out of an update by claiming it is already current.
    'server_time', v_now,
    'tenant_id',   v_device.tenant_id,
    'branch_id',   v_device.branch_id,

    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',               p.id,
               'name',             p.name,
               'sku',              p.sku,
               'unit',             p.unit,
               'allow_fractional', p.allow_fractional,
               'is_stock_tracked', p.is_stock_tracked,
               'tax_mode',         p.tax_mode,
               'tax_rate',         coalesce(p.tax_rate, 0),
               'updated_at',       p.updated_at
             ))
        from public.products p
       where p.tenant_id = v_device.tenant_id
         and p.is_active
         and (p_since is null or p.updated_at > p_since)
    ), '[]'::jsonb),

    -- Products the till must forget: deactivated, or deleted outright. Sent as bare ids
    -- because there is nothing else worth saying about them.
    'removed_products', coalesce((
      select jsonb_agg(p.id)
        from public.products p
       where p.tenant_id = v_device.tenant_id
         and not p.is_active
         and (p_since is null or p.updated_at > p_since)
    ), '[]'::jsonb),

    'barcodes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'barcode',    b.barcode,
               'product_id', b.product_id,
               'pack_size',  b.pack_size
             ))
        from public.product_barcodes b
        join public.products p on p.id = b.product_id and p.is_active
       where b.tenant_id = v_device.tenant_id
    ), '[]'::jsonb),

    -- Prices resolved for THIS branch: a branch-specific row wins over the tenant-wide
    -- one. Resolving here rather than on the terminal means one implementation of the
    -- rule, in the same place that charges for the sale.
    'prices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id',   x.product_id,
               'tier',         x.tier,
               'min_quantity', x.min_quantity,
               'amount',       x.amount
             ))
        from (
          select distinct on (pp.product_id, pp.tier, pp.min_quantity)
                 pp.product_id, pp.tier, pp.min_quantity, pp.amount
            from public.product_prices pp
            join public.products p on p.id = pp.product_id and p.is_active
           where pp.tenant_id = v_device.tenant_id
             and (pp.branch_id = v_device.branch_id or pp.branch_id is null)
             and pp.effective_to is null
             and pp.effective_from <= v_now
           order by pp.product_id, pp.tier, pp.min_quantity,
                    -- The branch override first, so DISTINCT ON keeps it.
                    (pp.branch_id is not null) desc
        ) x
    ), '[]'::jsonb),

    -- This branch's stock only.
    'stock', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', i.product_id,
               'quantity',   i.quantity - i.reserved,
               'as_of',      coalesce(i.last_movement_at, i.updated_at)
             ))
        from public.inventory i
        join public.products p on p.id = i.product_id and p.is_active
       where i.tenant_id = v_device.tenant_id
         and i.branch_id = v_device.branch_id
         and (p_since is null or i.updated_at > p_since)
    ), '[]'::jsonb),

    -- Name, phone and tier: enough to attach a sale to a customer and charge them the
    -- right price. Balance and credit limit are deliberately absent.
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',           c.id,
               'name',         c.name,
               'phone',        c.phone,
               'default_tier', c.default_tier
             ))
        from public.customers c
       where c.tenant_id = v_device.tenant_id
         and c.is_active
         and (p_since is null or c.updated_at > p_since)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

comment on function device_catalogue(uuid, text, text, timestamptz) is
  'What a terminal needs in order to sell offline, scoped to its own branch. Excludes cost, balances and every other branch.';

-- Only the server may call this: the pepper is an argument, and the pepper never leaves
-- the application environment. A terminal reaches it through the application, never
-- directly.
revoke execute on function device_catalogue(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function device_catalogue(uuid, text, text, timestamptz) to service_role;
