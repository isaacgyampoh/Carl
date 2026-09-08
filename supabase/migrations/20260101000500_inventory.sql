-- =============================================================================
-- 0005 · Inventory
--
-- ## Why a ledger, not a counter
--
-- `stock = stock - 1` answers "how many are there" and nothing else. When the count is
-- wrong - and in retail it eventually is - there is no way to find out when it went
-- wrong or what caused it. The shop is left with a number it cannot trust and no route
-- to a correct one.
--
-- Carl keeps two structures:
--
--   inventory_movements   append-only ledger; every change, with its cause
--   inventory             current quantity per product per branch
--
-- The ledger is the truth. `inventory` is a maintained running total kept alongside it
-- so the POS can answer "is there stock" with a single indexed read rather than summing
-- history on every scan.
--
-- Both are written inside the same transaction, always. A database test asserts that the
-- sum of the ledger equals the cached quantity, so the two cannot drift unnoticed.
--
-- ## Why the cached total exists at all
--
-- Summing a year of movements per line item at the till would be too slow. The trade-off
-- is a redundancy that must be maintained honestly - hence the reconciliation test.
-- =============================================================================

create type movement_type as enum (
  'OPENING_STOCK',
  'PURCHASE',
  'SALE',
  'SALE_RETURN',
  'PURCHASE_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'STOCK_COUNT',      -- variance applied after a physical count
  'DAMAGE',
  'EXPIRED',
  'THEFT',
  'SALE_VOID'         -- a completed sale reversed; restores stock
);

-- -----------------------------------------------------------------------------
-- inventory — current quantity per product per branch
-- -----------------------------------------------------------------------------

create table inventory (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  branch_id     uuid not null references branches (id) on delete cascade,
  product_id    uuid not null references products (id) on delete cascade,

  quantity      app.quantity not null default 0,

  -- Held for an unsettled transfer or an in-progress sale. Available = quantity - reserved.
  reserved      app.quantity not null default 0,

  -- Denormalised from products for the low-stock query, which would otherwise join every
  -- product row to evaluate a threshold per branch.
  reorder_level app.quantity not null default 0,

  last_counted_at    timestamptz,
  last_movement_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint inventory_reserved_non_negative check (reserved >= 0)
);

-- One row per product per branch. This is also the lock target when two terminals sell
-- the same product at once: both take a row lock here, and the second waits.
create unique index inventory_branch_product_key on inventory (branch_id, product_id);
create index inventory_tenant_idx on inventory (tenant_id);
create index inventory_product_idx on inventory (product_id);

-- The low-stock report, which runs on every dashboard load. Partial, so it stays small:
-- most products are not low.
create index inventory_low_stock_idx
  on inventory (branch_id, product_id)
  where quantity <= reorder_level;

comment on table inventory is
  'Current quantity per product per branch. A maintained total; inventory_movements is the truth.';
comment on column inventory.reserved is
  'Held for an unsettled transfer. Available stock is quantity - reserved.';

create trigger inventory_touch_updated_at
  before update on inventory
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- inventory_movements — the ledger
--
-- Append-only. A movement is never edited or deleted; a mistake is corrected by posting
-- an opposing movement, exactly as in double-entry bookkeeping. That is what makes the
-- history admissible when a shop is reconciling a discrepancy or investigating theft.
-- -----------------------------------------------------------------------------

create table inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  branch_id      uuid not null references branches (id) on delete cascade,
  product_id     uuid not null references products (id) on delete cascade,

  movement_type  movement_type not null,

  -- Signed. Negative removes stock. Storing the sign rather than a separate direction
  -- column means the ledger sums directly to the quantity on hand.
  quantity       app.quantity not null,

  -- The running total after this movement was applied. Makes "what was stock on 3 March"
  -- answerable without replaying the ledger, and makes a drift visible at a glance.
  balance_after  app.quantity not null,

  -- Unit cost at the time, for stock valuation and margin. Captured at movement time
  -- because average cost changes with later purchases.
  unit_cost      app.money_minor not null default 0,

  -- What caused this movement. Polymorphic rather than fifteen nullable foreign keys.
  reference_type text,
  reference_id   uuid,

  reason         text,
  notes          text,

  performed_by   uuid references profiles (id) on delete set null,
  device_id      uuid references devices (id) on delete set null,
  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  -- A movement of zero records nothing and would only pollute the ledger.
  constraint inventory_movements_quantity_non_zero check (quantity <> 0),
  constraint inventory_movements_unit_cost_non_negative check (unit_cost >= 0),
  -- Direction must match the movement type. This catches the inverted-sign bug - a
  -- return that removes stock - at write time rather than at stock-take.
  constraint inventory_movements_direction_matches_type check (
    case movement_type
      when 'SALE'            then quantity < 0
      when 'TRANSFER_OUT'    then quantity < 0
      when 'ADJUSTMENT_OUT'  then quantity < 0
      when 'DAMAGE'          then quantity < 0
      when 'EXPIRED'         then quantity < 0
      when 'THEFT'           then quantity < 0
      when 'PURCHASE_RETURN' then quantity < 0
      when 'PURCHASE'        then quantity > 0
      when 'SALE_RETURN'     then quantity > 0
      when 'TRANSFER_IN'     then quantity > 0
      when 'ADJUSTMENT_IN'   then quantity > 0
      when 'SALE_VOID'       then quantity > 0
      when 'OPENING_STOCK'   then quantity > 0
      -- A stock count variance may go either way.
      when 'STOCK_COUNT'     then true
    end
  )
);

-- The ledger for one product at one branch, newest first: the "stock card" view.
create index inventory_movements_branch_product_idx
  on inventory_movements (branch_id, product_id, occurred_at desc);

-- Tracing every movement caused by one sale, transfer or purchase.
create index inventory_movements_reference_idx
  on inventory_movements (reference_type, reference_id)
  where reference_id is not null;

create index inventory_movements_tenant_time_idx on inventory_movements (tenant_id, occurred_at desc);
create index inventory_movements_type_idx on inventory_movements (tenant_id, movement_type, occurred_at desc);

comment on table inventory_movements is
  'Append-only stock ledger. Corrections are posted as opposing movements, never edits.';
comment on column inventory_movements.balance_after is
  'Running total after this movement. Makes historical stock answerable without replaying the ledger.';

-- Append-only is enforced, not merely intended. Without this an UPDATE would silently
-- rewrite history and the ledger would be worth nothing.
create trigger inventory_movements_immutable
  before update or delete on inventory_movements
  for each row execute function app.reject_mutation();

-- -----------------------------------------------------------------------------
-- stock_transfers
-- -----------------------------------------------------------------------------

create type transfer_status as enum (
  'DRAFT',
  'REQUESTED',
  'APPROVED',
  'IN_TRANSIT',
  'RECEIVED',
  'CANCELLED'
);

create table stock_transfers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  reference       text not null,

  from_branch_id  uuid not null references branches (id) on delete restrict,
  to_branch_id    uuid not null references branches (id) on delete restrict,

  status          transfer_status not null default 'DRAFT',
  notes           text,

  requested_by    uuid references profiles (id) on delete set null,
  requested_at    timestamptz,
  approved_by     uuid references profiles (id) on delete set null,
  approved_at     timestamptz,
  dispatched_at   timestamptz,
  received_by     uuid references profiles (id) on delete set null,
  received_at     timestamptz,
  cancelled_by    uuid references profiles (id) on delete set null,
  cancelled_at    timestamptz,
  cancel_reason   text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint stock_transfers_distinct_branches check (from_branch_id <> to_branch_id),
  constraint stock_transfers_received_is_dated check (status <> 'RECEIVED' or received_at is not null),
  constraint stock_transfers_cancellation_documented check (
    status <> 'CANCELLED' or (cancelled_at is not null and cancel_reason is not null)
  )
);

create unique index stock_transfers_tenant_reference_key on stock_transfers (tenant_id, reference);
create index stock_transfers_from_idx on stock_transfers (from_branch_id, status);
create index stock_transfers_to_idx on stock_transfers (to_branch_id, status);
create index stock_transfers_tenant_time_idx on stock_transfers (tenant_id, created_at desc);

create trigger stock_transfers_touch_updated_at
  before update on stock_transfers
  for each row execute function app.touch_updated_at();

create table stock_transfer_items (
  id                 uuid primary key default gen_random_uuid(),
  transfer_id        uuid not null references stock_transfers (id) on delete cascade,
  tenant_id          uuid not null references tenants (id) on delete cascade,
  product_id         uuid not null references products (id) on delete restrict,

  quantity_requested app.quantity not null,
  quantity_sent      app.quantity,
  -- Recorded separately from what was sent. Stock lost in transit is a real event, and
  -- forcing received to equal sent would hide it.
  quantity_received  app.quantity,

  unit_cost          app.money_minor not null default 0,
  notes              text,
  created_at         timestamptz not null default now(),

  constraint transfer_items_requested_positive check (quantity_requested > 0),
  constraint transfer_items_sent_non_negative check (quantity_sent is null or quantity_sent >= 0),
  constraint transfer_items_received_non_negative check (quantity_received is null or quantity_received >= 0),
  -- More cannot arrive than left.
  constraint transfer_items_received_not_over_sent check (
    quantity_received is null or quantity_sent is null or quantity_received <= quantity_sent
  )
);

create unique index stock_transfer_items_transfer_product_key
  on stock_transfer_items (transfer_id, product_id);
create index stock_transfer_items_product_idx on stock_transfer_items (product_id);

comment on column stock_transfer_items.quantity_received is
  'What actually arrived. Deliberately allowed to differ from quantity_sent so loss in transit is visible.';

-- -----------------------------------------------------------------------------
-- stock_counts (stock taking)
-- -----------------------------------------------------------------------------

create type stock_count_status as enum ('DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED');

create table stock_counts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  branch_id     uuid not null references branches (id) on delete cascade,
  reference     text not null,

  status        stock_count_status not null default 'DRAFT',
  -- A count may cover one category or the whole branch.
  category_id   uuid references categories (id) on delete set null,
  notes         text,

  started_by    uuid references profiles (id) on delete set null,
  started_at    timestamptz,
  submitted_at  timestamptz,
  approved_by   uuid references profiles (id) on delete set null,
  approved_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint stock_counts_approved_is_dated check (status <> 'APPROVED' or approved_at is not null)
);

create unique index stock_counts_tenant_reference_key on stock_counts (tenant_id, reference);
create index stock_counts_branch_idx on stock_counts (branch_id, status);

-- One open count per branch. Two simultaneous counts would each apply a variance against
-- a moving total and both would be wrong.
create unique index stock_counts_one_open_per_branch
  on stock_counts (branch_id)
  where status in ('DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL');

create trigger stock_counts_touch_updated_at
  before update on stock_counts
  for each row execute function app.touch_updated_at();

create table stock_count_items (
  id                uuid primary key default gen_random_uuid(),
  stock_count_id    uuid not null references stock_counts (id) on delete cascade,
  tenant_id         uuid not null references tenants (id) on delete cascade,
  product_id        uuid not null references products (id) on delete restrict,

  -- What the system believed at the moment counting began. Frozen, so a sale during the
  -- count does not silently change the variance being reviewed.
  expected_quantity app.quantity not null,
  counted_quantity  app.quantity,

  -- Stored rather than computed so the approved variance is exactly what was reviewed,
  -- even if expected_quantity is later corrected.
  variance          app.quantity,

  unit_cost         app.money_minor not null default 0,
  notes             text,

  counted_by        uuid references profiles (id) on delete set null,
  counted_at        timestamptz,
  created_at        timestamptz not null default now()
);

create unique index stock_count_items_count_product_key on stock_count_items (stock_count_id, product_id);
create index stock_count_items_product_idx on stock_count_items (product_id);
-- The review screen: only lines that disagree.
create index stock_count_items_variance_idx
  on stock_count_items (stock_count_id)
  where variance is not null and variance <> 0;

comment on column stock_count_items.expected_quantity is
  'System quantity frozen when counting began, so concurrent sales do not move the variance under review.';
