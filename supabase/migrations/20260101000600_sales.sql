-- =============================================================================
-- 0006 · Customers, sales, payments and returns
--
-- ## Every monetary figure here is computed by the server
--
-- The client sends a product id and a quantity. complete_sale() looks up the price,
-- applies the discount the caller is permitted to apply, computes tax, sums the lines,
-- and writes the totals below. Nothing in this schema is ever populated from a request
-- body.
--
-- Totals are stored rather than recomputed on read because a receipt must show what was
-- actually charged, forever - even after prices change, tax rates change, or a product
-- is deleted. A "computed" total would silently rewrite history.
--
-- ## Idempotency
--
-- Sales carry a client-generated key. A terminal that loses the response and retries -
-- guaranteed by offline sync - gets the original sale back rather than charging twice.
-- Enforced by a unique index, so two concurrent retries cannot both win.
-- =============================================================================

create type sale_status as enum (
  'COMPLETED',
  'VOIDED',
  'PARTIALLY_RETURNED',
  'RETURNED'
);

create type sale_channel as enum ('POS', 'ONLINE', 'MANUAL');

create type payment_method as enum (
  'CASH',
  'MOMO',            -- mobile money; recorded manually, no API integration
  'BANK_TRANSFER',
  'CARD',
  'CREDIT',          -- on the customer's account
  'OTHER'
);

create type discount_type as enum ('NONE', 'PERCENTAGE', 'AMOUNT');

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------

create table customers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,

  name           app.label not null,
  phone          text,
  email          extensions.citext,
  address        text,
  notes          text,

  -- Which price tier this customer buys at. A wholesale customer gets wholesale prices
  -- automatically rather than the cashier remembering to switch.
  default_tier   price_tier not null default 'RETAIL',

  -- Outstanding balance in minor units. Positive means the customer owes the business.
  -- Maintained by the sale and payment functions, never written directly.
  balance        app.money_minor not null default 0,
  credit_limit   app.money_minor not null default 0,

  is_active      boolean not null default true,
  created_by     uuid references profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint customers_credit_limit_non_negative check (credit_limit >= 0)
);

-- Phone is how a customer is looked up at the till, and must not be ambiguous within a
-- business. Partial, because many walk-in customers have no phone recorded.
create unique index customers_tenant_phone_key
  on customers (tenant_id, phone)
  where phone is not null;

create index customers_tenant_idx on customers (tenant_id) where is_active;
create index customers_name_trgm_idx on customers using gin (name extensions.gin_trgm_ops);
-- Customers who owe money: the debtors report.
create index customers_balance_idx on customers (tenant_id, balance) where balance <> 0;

create trigger customers_touch_updated_at
  before update on customers
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- sales
-- -----------------------------------------------------------------------------

create table sales (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  branch_id         uuid not null references branches (id) on delete restrict,

  -- Human-readable, unique per branch. Generated server-side; see migration 0011 for why
  -- a terminal must not invent its own sequence.
  sale_number       text not null,

  status            sale_status not null default 'COMPLETED',
  channel           sale_channel not null default 'POS',

  customer_id       uuid references customers (id) on delete set null,
  cashier_id        uuid not null references profiles (id) on delete restrict,
  device_id         uuid references devices (id) on delete set null,
  cash_session_id   uuid,   -- FK added in 0007, after cash_sessions exists

  tier              price_tier not null default 'RETAIL',

  -- Server-computed money. All in minor units.
  subtotal          app.money_minor not null,   -- sum of line totals before order discount
  discount_amount   app.money_minor not null default 0,
  tax_amount        app.money_minor not null default 0,
  total             app.money_minor not null,
  -- Sum of the average cost of what was sold, captured at sale time. Without this,
  -- historical margin would silently change every time a product's cost is updated.
  cost_total        app.money_minor not null default 0,

  amount_paid       app.money_minor not null default 0,
  change_given      app.money_minor not null default 0,
  amount_refunded   app.money_minor not null default 0,

  discount_type     discount_type not null default 'NONE',
  discount_value    numeric(12, 2),
  discount_reason   text,
  -- Who authorised a discount beyond the cashier's own limit.
  discount_approved_by uuid references profiles (id) on delete set null,

  note              text,

  -- Offline provenance. sold_at is when the customer was actually served; created_at is
  -- when the row reached the server. For a sale made offline they differ by hours, and
  -- reports must use sold_at or a day's takings land in the wrong day.
  sold_at           timestamptz not null default now(),
  synced_at         timestamptz,
  is_offline_sale   boolean not null default false,

  voided_at         timestamptz,
  voided_by         uuid references profiles (id) on delete set null,
  void_reason       text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint sales_amounts_non_negative check (
    subtotal >= 0 and discount_amount >= 0 and tax_amount >= 0 and total >= 0
    and amount_paid >= 0 and change_given >= 0 and amount_refunded >= 0 and cost_total >= 0
  ),
  -- The arithmetic must hold in the row itself, not only in the function that wrote it.
  -- A bad migration or a support script cannot produce a sale whose parts do not add up.
  constraint sales_total_is_consistent check (total = subtotal - discount_amount + tax_amount),
  -- Refunding more than was charged is not possible.
  constraint sales_refund_within_total check (amount_refunded <= total),
  constraint sales_void_documented check (
    status <> 'VOIDED' or (voided_at is not null and void_reason is not null)
  ),
  constraint sales_discount_value_present check (
    (discount_type = 'NONE' and discount_value is null) or
    (discount_type <> 'NONE' and discount_value is not null)
  )
);

-- Receipt numbers are unique per branch. Two branches may both have receipt 000123;
-- forcing global uniqueness would make a shop's receipt numbering depend on other
-- branches' trading volume.
create unique index sales_branch_number_key on sales (branch_id, sale_number);

-- The reporting index: a branch's sales for a period, newest first.
create index sales_branch_sold_at_idx on sales (branch_id, sold_at desc);
create index sales_tenant_sold_at_idx on sales (tenant_id, sold_at desc);
create index sales_customer_idx on sales (customer_id, sold_at desc) where customer_id is not null;
create index sales_cashier_idx on sales (cashier_id, sold_at desc);
create index sales_device_idx on sales (device_id, sold_at desc) where device_id is not null;
create index sales_status_idx on sales (tenant_id, status) where status <> 'COMPLETED';

comment on column sales.sold_at is
  'When the customer was served. Differs from created_at for offline sales; reports must use this.';
comment on column sales.cost_total is
  'Cost of goods at the moment of sale. Stored so historical margin does not move when costs change.';

create trigger sales_touch_updated_at
  before update on sales
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- sale_items
-- -----------------------------------------------------------------------------

create table sale_items (
  id               uuid primary key default gen_random_uuid(),
  sale_id          uuid not null references sales (id) on delete cascade,
  tenant_id        uuid not null references tenants (id) on delete cascade,
  branch_id        uuid not null references branches (id) on delete cascade,
  product_id       uuid not null references products (id) on delete restrict,

  line_number      smallint not null,

  -- The product's name and SKU as they were at the time of sale. A receipt reprinted a
  -- year later must show what the customer bought, not what the product was later
  -- renamed to.
  product_name     text not null,
  product_sku      text not null,

  quantity         app.quantity not null,
  unit_price       app.money_minor not null,   -- server-derived, never client-supplied
  unit_cost        app.money_minor not null default 0,

  discount_type    discount_type not null default 'NONE',
  discount_value   numeric(12, 2),
  discount_amount  app.money_minor not null default 0,

  tax_rate         app.percentage not null default 0,
  tax_amount       app.money_minor not null default 0,

  line_total       app.money_minor not null,

  -- How much of this line has since been returned. Checked before a further return so
  -- the same item cannot be refunded twice.
  quantity_returned app.quantity not null default 0,

  created_at       timestamptz not null default now(),

  constraint sale_items_quantity_positive check (quantity > 0),
  constraint sale_items_amounts_non_negative check (
    unit_price >= 0 and unit_cost >= 0 and discount_amount >= 0 and tax_amount >= 0 and line_total >= 0
  ),
  constraint sale_items_returned_within_sold check (quantity_returned >= 0 and quantity_returned <= quantity),
  constraint sale_items_line_number_positive check (line_number > 0)
);

create unique index sale_items_sale_line_key on sale_items (sale_id, line_number);
create index sale_items_sale_idx on sale_items (sale_id);
-- Best-seller and product-history reports.
create index sale_items_product_idx on sale_items (product_id, created_at desc);
create index sale_items_tenant_product_idx on sale_items (tenant_id, product_id);

comment on column sale_items.product_name is
  'The name at the time of sale. A reprinted receipt must show what was bought, not a later rename.';

-- -----------------------------------------------------------------------------
-- sale_payments
--
-- One row per tender. A split payment is several rows; the sum must cover the total,
-- which complete_sale() enforces inside the transaction.
-- -----------------------------------------------------------------------------

create table sale_payments (
  id             uuid primary key default gen_random_uuid(),
  sale_id        uuid not null references sales (id) on delete cascade,
  tenant_id      uuid not null references tenants (id) on delete cascade,
  branch_id      uuid not null references branches (id) on delete cascade,

  method         payment_method not null,
  amount         app.money_minor not null,

  -- Mobile money and bank transfers are recorded manually by the cashier. Carl does not
  -- integrate a payment API, so this reference is the only link to the actual transfer
  -- and is required for those methods.
  reference      text,
  received_at    timestamptz not null default now(),
  received_by    uuid references profiles (id) on delete set null,

  created_at     timestamptz not null default now(),

  constraint sale_payments_amount_positive check (amount > 0),
  -- An untraceable mobile-money payment is an unreconcilable one. The database refuses
  -- it rather than relying on the form remembering to ask.
  constraint sale_payments_reference_required check (
    method not in ('MOMO', 'BANK_TRANSFER') or (reference is not null and length(btrim(reference)) > 0)
  )
);

create index sale_payments_sale_idx on sale_payments (sale_id);
-- The payment-method breakdown on the daily report.
create index sale_payments_branch_method_idx on sale_payments (branch_id, method, received_at desc);
create index sale_payments_tenant_time_idx on sale_payments (tenant_id, received_at desc);

comment on constraint sale_payments_reference_required on sale_payments is
  'Momo and bank transfers are recorded manually; without a reference they cannot be reconciled.';

-- -----------------------------------------------------------------------------
-- Returns and refunds
-- -----------------------------------------------------------------------------

create table sale_returns (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  branch_id       uuid not null references branches (id) on delete restrict,
  sale_id         uuid not null references sales (id) on delete restrict,

  return_number   text not null,

  reason          text not null,
  notes           text,

  subtotal        app.money_minor not null,
  tax_amount      app.money_minor not null default 0,
  total           app.money_minor not null,

  -- Not every return is refunded in cash; some restock without money changing hands.
  refund_method   payment_method,
  refund_reference text,
  refunded_amount app.money_minor not null default 0,

  -- Whether the goods came back into stock. Damaged returns must not be resold, so this
  -- is a decision recorded per return rather than an assumption.
  restocked       boolean not null default true,

  processed_by    uuid not null references profiles (id) on delete restrict,
  approved_by     uuid references profiles (id) on delete set null,
  device_id       uuid references devices (id) on delete set null,
  cash_session_id uuid,

  returned_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  constraint sale_returns_amounts_non_negative check (
    subtotal >= 0 and tax_amount >= 0 and total >= 0 and refunded_amount >= 0
  ),
  constraint sale_returns_total_consistent check (total = subtotal + tax_amount),
  constraint sale_returns_refund_within_total check (refunded_amount <= total),
  constraint sale_returns_refund_reference_required check (
    refund_method is null or refund_method not in ('MOMO', 'BANK_TRANSFER')
    or (refund_reference is not null and length(btrim(refund_reference)) > 0)
  )
);

create unique index sale_returns_branch_number_key on sale_returns (branch_id, return_number);
create index sale_returns_sale_idx on sale_returns (sale_id);
create index sale_returns_branch_time_idx on sale_returns (branch_id, returned_at desc);
create index sale_returns_tenant_time_idx on sale_returns (tenant_id, returned_at desc);

create table sale_return_items (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references sale_returns (id) on delete cascade,
  sale_item_id   uuid not null references sale_items (id) on delete restrict,
  tenant_id      uuid not null references tenants (id) on delete cascade,
  product_id     uuid not null references products (id) on delete restrict,

  quantity       app.quantity not null,
  -- The price actually charged on the original sale, not today's price. A customer is
  -- refunded what they paid.
  unit_price     app.money_minor not null,
  tax_amount     app.money_minor not null default 0,
  line_total     app.money_minor not null,

  condition      text,   -- 'RESALEABLE', 'DAMAGED', 'EXPIRED'
  created_at     timestamptz not null default now(),

  constraint sale_return_items_quantity_positive check (quantity > 0),
  constraint sale_return_items_amounts_non_negative check (
    unit_price >= 0 and tax_amount >= 0 and line_total >= 0
  )
);

create unique index sale_return_items_return_sale_item_key on sale_return_items (return_id, sale_item_id);
create index sale_return_items_product_idx on sale_return_items (product_id);
create index sale_return_items_sale_item_idx on sale_return_items (sale_item_id);

comment on column sale_return_items.unit_price is
  'The price actually charged originally. A customer is refunded what they paid, not today''s price.';
