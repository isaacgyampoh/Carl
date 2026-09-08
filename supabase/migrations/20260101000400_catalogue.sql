-- =============================================================================
-- 0004 · Catalogue: categories, products, barcodes and pricing
--
-- ## Products are tenant-wide; stock is branch-specific
--
-- "Coca-Cola 500ml" is one product for the business, not three products because there
-- are three branches. Duplicating the definition per branch would mean a price change
-- had to be applied three times, reports would have to stitch the copies back together,
-- and a barcode scan would be ambiguous.
--
-- So the product is defined once at tenant level, and the quantity on hand lives in a
-- separate branch-scoped table (migration 0005).
--
-- ## Prices are never sent by a client
--
-- The pricing tables here are the only source of a price. At checkout the client sends a
-- product and a quantity; the server looks up what that costs. A price arriving in a
-- request body is not validated - it is ignored.
-- =============================================================================

create type price_tier as enum ('RETAIL', 'WHOLESALE');

create type tax_mode as enum (
  'INCLUSIVE',  -- the price on the shelf already contains tax (the norm in Ghana)
  'EXCLUSIVE',  -- tax is added at the till
  'EXEMPT'
);

-- -----------------------------------------------------------------------------
-- categories
-- -----------------------------------------------------------------------------

create table categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  parent_id   uuid references categories (id) on delete set null,

  name        app.label not null,
  description text,
  colour      text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint categories_colour_format check (colour is null or colour ~ '^#[0-9A-Fa-f]{6}$'),
  constraint categories_not_own_parent check (parent_id is distinct from id)
);

create unique index categories_tenant_name_key on categories (tenant_id, lower(name));
create index categories_tenant_idx on categories (tenant_id) where is_active;
create index categories_parent_idx on categories (parent_id);

create trigger categories_touch_updated_at
  before update on categories
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- products
-- -----------------------------------------------------------------------------

create table products (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  category_id       uuid references categories (id) on delete set null,

  name              app.label not null,
  sku               text not null,
  description       text,
  image_url         text,

  -- Unit of measure. Free text because shops sell in units Carl cannot enumerate
  -- ("crate", "olonka", "yard"); constrained only in length.
  unit              text not null default 'unit',
  -- Whether this product may be sold in fractional quantities. A shop cannot sell half a
  -- bottle, and permitting it produces stock levels that never reconcile.
  allow_fractional  boolean not null default false,

  -- Cost is the weighted average from purchases, maintained by receive_purchase().
  -- Stored here for margin reporting; it is NOT a price and is never shown at the till
  -- (see the products.view_cost permission).
  average_cost      app.money_minor not null default 0,
  last_cost         app.money_minor not null default 0,

  tax_mode          tax_mode not null default 'INCLUSIVE',
  tax_rate          app.percentage,

  -- Reorder thresholds, evaluated per branch against that branch's stock.
  min_stock         app.quantity not null default 0,
  reorder_level     app.quantity not null default 0,
  reorder_quantity  app.quantity not null default 0,

  is_active         boolean not null default true,
  -- A service has no stock and is never blocked by a stock check.
  is_stock_tracked  boolean not null default true,

  created_by        uuid references profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint products_sku_format check (sku ~ '^[A-Z0-9._-]{1,64}$'),
  constraint products_unit_length check (length(btrim(unit)) between 1 and 32),
  constraint products_costs_non_negative check (average_cost >= 0 and last_cost >= 0),
  constraint products_thresholds_non_negative check (
    min_stock >= 0 and reorder_level >= 0 and reorder_quantity >= 0
  ),
  -- An exempt product must not carry a rate, and a taxed one must.
  constraint products_tax_rate_consistent check (
    (tax_mode = 'EXEMPT' and tax_rate is null) or (tax_mode <> 'EXEMPT')
  )
);

-- SKUs are unique per tenant. Global uniqueness would leak the existence of other
-- businesses' products through collision errors.
create unique index products_tenant_sku_key on products (tenant_id, sku);
create index products_tenant_active_idx on products (tenant_id, is_active) include (name);
create index products_category_idx on products (category_id) where is_active;

-- POS search. Trigram indexes make "coca" match "Coca-Cola 500ml" and survive the typos
-- a cashier makes under queue pressure; a LIKE 'coca%' index would not.
create index products_name_trgm_idx on products using gin (name extensions.gin_trgm_ops);
create index products_sku_trgm_idx on products using gin (sku extensions.gin_trgm_ops);

comment on column products.average_cost is
  'Weighted average cost from purchases. Margin reporting only - never a selling price.';
comment on column products.is_stock_tracked is
  'False for services, which have no stock and are never blocked by a stock check.';

create trigger products_touch_updated_at
  before update on products
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- product_barcodes
--
-- Several barcodes per product is the normal case, not an edge case: a manufacturer
-- changes packaging, a shop prints its own labels for loose goods, a case and a single
-- bottle scan differently.
-- -----------------------------------------------------------------------------

create table product_barcodes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete cascade,
  product_id uuid not null references products (id) on delete cascade,

  barcode    text not null,
  -- The barcode printed on the item, used when reprinting a label.
  is_primary boolean not null default false,
  -- How many base units one scan represents. Scanning a case of 24 adds 24, not 1.
  pack_size  app.quantity not null default 1,

  created_at timestamptz not null default now(),

  constraint product_barcodes_format check (barcode ~ '^[A-Za-z0-9._-]{4,64}$'),
  constraint product_barcodes_pack_positive check (pack_size > 0)
);

-- A barcode resolves to exactly one product within a tenant - the guarantee the POS
-- depends on. Enforced by the database, because a duplicate would make a scan ambiguous
-- and the cashier would never know which product was rung up.
create unique index product_barcodes_tenant_barcode_key on product_barcodes (tenant_id, barcode);
create index product_barcodes_product_idx on product_barcodes (product_id);
create unique index product_barcodes_one_primary_per_product
  on product_barcodes (product_id) where is_primary;

comment on column product_barcodes.pack_size is
  'Base units per scan. A case barcode with pack_size 24 adds 24 units to the cart.';

-- -----------------------------------------------------------------------------
-- product_prices
--
-- ## Why prices are rows rather than columns
--
-- Two tiers exist today (retail and wholesale) and a third will be asked for. More
-- importantly, prices change, and a shop must be able to answer "what did this cost in
-- March" when a customer returns an item.
--
-- Each price therefore has a validity window. A price with effective_to = NULL is the
-- one currently in force; changing a price closes the old row and opens a new one, so
-- history survives.
-- -----------------------------------------------------------------------------

create table product_prices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  product_id     uuid not null references products (id) on delete cascade,

  -- NULL means the price applies to every branch. A row with a branch overrides it,
  -- which is how a shop charges more at the airport site without duplicating products.
  branch_id      uuid references branches (id) on delete cascade,

  tier           price_tier not null default 'RETAIL',
  amount         app.money_minor not null,

  -- The smallest quantity this price applies to. Wholesale tiers are quantity breaks.
  min_quantity   app.quantity not null default 0,

  effective_from timestamptz not null default now(),
  effective_to   timestamptz,

  created_by     uuid references profiles (id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint product_prices_amount_non_negative check (amount >= 0),
  constraint product_prices_min_quantity_non_negative check (min_quantity >= 0),
  constraint product_prices_window_ordered check (effective_to is null or effective_to > effective_from)
);

-- Exactly one live price per product, tier, branch and quantity break. Enforced with
-- partial unique indexes so two concurrent price changes cannot both take effect and
-- leave the till with an ambiguous lookup.
create unique index product_prices_live_branch_key
  on product_prices (product_id, tier, branch_id, min_quantity)
  where effective_to is null and branch_id is not null;

create unique index product_prices_live_default_key
  on product_prices (product_id, tier, min_quantity)
  where effective_to is null and branch_id is null;

-- The POS price lookup. Ordered to serve "current prices for this product" directly.
create index product_prices_lookup_idx
  on product_prices (product_id, tier, min_quantity desc)
  where effective_to is null;

create index product_prices_tenant_idx on product_prices (tenant_id);

comment on table product_prices is
  'The only source of a selling price. Windowed, so a refund can be valued at the price actually charged.';
comment on column product_prices.branch_id is
  'NULL applies to every branch; a row with a branch overrides the default for that branch.';
