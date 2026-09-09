-- =============================================================================
-- Carl Desktop — local SQLite schema.
--
-- ## What is kept here, and what is not
--
-- Only what a terminal needs in order to sell: the catalogue, prices, barcodes, customers
-- and its own configuration — plus the queue of transactions that have not yet reached the
-- server.
--
-- Deliberately absent: sales history, staff records, purchasing, suppliers, reports, other
-- branches' stock. A stolen terminal should yield a catalogue, not a business.
--
-- ## The queue is the important table
--
-- Everything else here is a cache and can be re-downloaded. `sync_queue` holds sales that
-- exist nowhere else yet. It is written before a receipt is printed, and a row leaves
-- `PENDING` only when the server has confirmed it.
-- =============================================================================

-- NOTE: the PRAGMAs this database needs are NOT here.
--
-- `journal_mode = WAL` cannot be set inside a transaction, and this file is applied as a
-- migration, which runs in one. Left here it fails the migration outright and the terminal
-- comes up with no schema at all.
--
-- They are applied by the connection adapter immediately after opening instead — see
-- `TauriSqliteConnection.open()` and `NodeSqliteConnection` — so every caller gets them and
-- this file stays a pure schema definition.

-- -----------------------------------------------------------------------------
-- Device configuration. Exactly one row.
--
-- The device secret is NOT here — it lives in the OS credential store. A file the user can
-- read is not where a credential belongs.
-- -----------------------------------------------------------------------------
create table if not exists device_config (
  id                  integer primary key check (id = 1),
  device_id           text not null,
  tenant_id           text not null,
  branch_id           text not null,
  device_code         text not null,
  branch_name         text not null,
  tenant_name         text not null,
  currency_code       text not null default 'GHS',
  -- How long this terminal may keep selling without reaching the server.
  authorized_until    text,
  last_sync_at        text,
  catalogue_version   text,
  -- Difference between this machine's clock and the server's, measured at each sync.
  -- An offline sale is stamped with the corrected time, so a terminal with a wrong clock
  -- does not put a Saturday's takings into Monday.
  clock_offset_ms     integer not null default 0,
  activated_at        text not null
);

-- -----------------------------------------------------------------------------
-- Local settings.
--
-- Durable key/value for the handful of things a terminal must remember before it has a
-- `device_config` row at all. The install id is the reason this exists: it is generated on
-- first run and is what makes a retried activation idempotent, so it must survive both a
-- failed activation and a cleared webview store. Browser storage would not.
--
-- Not a place for credentials. Those are in the OS credential store.
-- -----------------------------------------------------------------------------
create table if not exists local_settings (
  key   text primary key,
  value text not null
);

-- -----------------------------------------------------------------------------
-- Catalogue cache
-- -----------------------------------------------------------------------------
create table if not exists products (
  id                text primary key,
  name              text not null,
  sku               text not null,
  unit              text not null default 'unit',
  allow_fractional  integer not null default 0,
  is_stock_tracked  integer not null default 1,
  tax_mode          text not null default 'INCLUSIVE',
  tax_rate          real not null default 0,
  updated_at        text not null
);

create index if not exists products_name_idx on products (name);
create index if not exists products_sku_idx on products (sku);

create table if not exists product_barcodes (
  barcode    text primary key,
  product_id text not null references products (id) on delete cascade,
  pack_size  real not null default 1
);

create table if not exists product_prices (
  product_id   text not null references products (id) on delete cascade,
  tier         text not null,
  min_quantity real not null default 0,
  amount       integer not null,
  primary key (product_id, tier, min_quantity)
);

create table if not exists stock_levels (
  product_id text primary key references products (id) on delete cascade,
  quantity   real not null default 0,
  -- The moment the server last confirmed this figure. Displayed to the cashier when
  -- offline, because a stock number of unknown age presented as current is worse than one
  -- labelled as stale.
  as_of      text not null
);

create table if not exists customers (
  id           text primary key,
  name         text not null,
  phone        text,
  default_tier text not null default 'RETAIL'
);

create index if not exists customers_phone_idx on customers (phone);

-- -----------------------------------------------------------------------------
-- The sync queue
--
-- Written before the receipt prints. A row here is a sale that exists nowhere else.
-- -----------------------------------------------------------------------------
create table if not exists sync_queue (
  -- The idempotency key. Generated once, reused for every retry — that is what makes
  -- re-sending safe.
  id                text primary key,
  operation         text not null,
  payload           text not null,          -- JSON
  state             text not null default 'PENDING'
                      check (state in ('PENDING','IN_FLIGHT','SYNCED','CONFLICT','FAILED','ABANDONED')),
  occurred_at       text not null,          -- when the sale was actually made
  attempts          integer not null default 0,
  last_attempt_at   text,
  next_attempt_at   text,
  last_error        text,
  last_error_code   text,
  remote_id         text,
  conflict_id       text,
  created_at        text not null default (datetime('now'))
);

-- The engine's claim query: what is ready to send, oldest sale first.
create index if not exists sync_queue_ready_idx
  on sync_queue (occurred_at)
  where state in ('PENDING', 'FAILED');

-- The "needs a human" view: conflicts and abandoned operations.
create index if not exists sync_queue_attention_idx
  on sync_queue (state)
  where state in ('CONFLICT', 'ABANDONED');

-- -----------------------------------------------------------------------------
-- Local receipts
--
-- Kept so a customer who returns an hour later can have their receipt reprinted, even if
-- the sale has not yet reached the server.
-- -----------------------------------------------------------------------------
create table if not exists local_receipts (
  queue_id     text primary key references sync_queue (id) on delete cascade,
  receipt_body text not null,
  printed_at   text
);
