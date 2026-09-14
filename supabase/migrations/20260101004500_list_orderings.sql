-- Indexes for the way the lists are actually ordered.
--
-- Three paged screens filter by `tenant_id` and order by a column no index carried, so
-- PostgreSQL read every row of the business and sorted them to show fifty. Measured on
-- 20,000 rows, as the manager who opens the screen, best of three:
--
--   Customer list, first page     11.7 ms  ->  0.1 ms
--   Purchases, first page         13.3 ms  ->  0.6 ms
--   Product list, first page       5.6 ms  ->  0.1 ms
--
-- Small numbers today, and they are small because the sort is the whole cost: it grows with
-- everything a shop has ever recorded, while an index that already carries the order does not
-- grow at all. This is the difference between a list that opens the same way in a shop's fifth
-- year as in its first.
--
-- Every other paged screen already had its index — expenses, returns, transfers, till
-- sessions, the audit log, notifications and sales were all checked.

-- /customers: `where tenant_id = $1 order by name`
create index customers_tenant_name_idx on public.customers (tenant_id, name);

-- /purchases: `where tenant_id = $1 order by created_at desc`
create index purchases_tenant_created_idx on public.purchases (tenant_id, created_at desc);

-- /products: `where tenant_id = $1 order by name`. There is an index on (tenant_id,
-- is_active) INCLUDE (name), which answers "is this one active" but carries no order, so the
-- list still sorted the whole catalogue.
create index products_tenant_name_idx on public.products (tenant_id, name);

-- /suppliers orders by name too, and its index is on lower(name) — which a plain `order by
-- name` cannot use. A shop has tens of suppliers rather than thousands, so this is left
-- alone rather than indexed twice; it is recorded here so the next person does not wonder.
