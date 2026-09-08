-- =============================================================================
-- 0007 · Suppliers, purchasing, expenses and the cash register
-- =============================================================================

create type purchase_status as enum (
  'DRAFT',
  'ORDERED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED'
);

create type payment_status as enum ('UNPAID', 'PARTIAL', 'PAID');

-- -----------------------------------------------------------------------------
-- suppliers
-- -----------------------------------------------------------------------------

create table suppliers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,

  name           app.label not null,
  contact_name   text,
  phone          text,
  email          extensions.citext,
  address        text,
  notes          text,

  -- Days from invoice to payment due. Drives the payables ageing report.
  payment_terms_days smallint not null default 0,

  -- Outstanding balance in minor units; positive means the business owes the supplier.
  balance        app.money_minor not null default 0,

  is_active      boolean not null default true,
  created_by     uuid references profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint suppliers_payment_terms_sane check (payment_terms_days between 0 and 365)
);

create unique index suppliers_tenant_name_key on suppliers (tenant_id, lower(name));
create index suppliers_tenant_idx on suppliers (tenant_id) where is_active;
create index suppliers_balance_idx on suppliers (tenant_id, balance) where balance <> 0;

create trigger suppliers_touch_updated_at
  before update on suppliers
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- purchases
-- -----------------------------------------------------------------------------

create table purchases (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  branch_id         uuid not null references branches (id) on delete restrict,
  supplier_id       uuid references suppliers (id) on delete restrict,

  reference         text not null,
  supplier_invoice_no text,

  status            purchase_status not null default 'DRAFT',
  payment_status    payment_status not null default 'UNPAID',

  subtotal          app.money_minor not null default 0,
  discount_amount   app.money_minor not null default 0,
  tax_amount        app.money_minor not null default 0,
  -- Delivery and handling. Excluded from the cost of goods on purpose: apportioning
  -- freight across lines is a landed-cost calculation Carl does not yet do, and silently
  -- folding it into unit cost would quietly distort every margin figure.
  shipping_amount   app.money_minor not null default 0,
  total             app.money_minor not null default 0,
  amount_paid       app.money_minor not null default 0,

  notes             text,
  ordered_at        timestamptz,
  expected_at       timestamptz,
  received_at       timestamptz,
  due_at            timestamptz,

  created_by        uuid references profiles (id) on delete set null,
  received_by       uuid references profiles (id) on delete set null,
  cancelled_at      timestamptz,
  cancel_reason     text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint purchases_amounts_non_negative check (
    subtotal >= 0 and discount_amount >= 0 and tax_amount >= 0
    and shipping_amount >= 0 and total >= 0 and amount_paid >= 0
  ),
  constraint purchases_total_consistent check (
    total = subtotal - discount_amount + tax_amount + shipping_amount
  ),
  constraint purchases_paid_within_total check (amount_paid <= total),
  constraint purchases_received_is_dated check (
    status not in ('RECEIVED', 'PARTIALLY_RECEIVED') or received_at is not null
  ),
  constraint purchases_cancellation_documented check (
    status <> 'CANCELLED' or (cancelled_at is not null and cancel_reason is not null)
  )
);

create unique index purchases_tenant_reference_key on purchases (tenant_id, reference);
create index purchases_branch_idx on purchases (branch_id, created_at desc);
create index purchases_supplier_idx on purchases (supplier_id, created_at desc);
create index purchases_tenant_status_idx on purchases (tenant_id, status);
-- The payables ageing report: what is owed and when it fell due.
create index purchases_outstanding_idx
  on purchases (tenant_id, due_at)
  where payment_status <> 'PAID' and status <> 'CANCELLED';

create trigger purchases_touch_updated_at
  before update on purchases
  for each row execute function app.touch_updated_at();

create table purchase_items (
  id                 uuid primary key default gen_random_uuid(),
  purchase_id        uuid not null references purchases (id) on delete cascade,
  tenant_id          uuid not null references tenants (id) on delete cascade,
  product_id         uuid not null references products (id) on delete restrict,

  line_number        smallint not null,
  quantity_ordered   app.quantity not null,
  -- Deliveries arrive short. Tracked separately so a partial delivery can be received
  -- without closing the order.
  quantity_received  app.quantity not null default 0,

  unit_cost          app.money_minor not null,
  discount_amount    app.money_minor not null default 0,
  tax_amount         app.money_minor not null default 0,
  line_total         app.money_minor not null,

  expiry_date        date,
  batch_number       text,

  created_at         timestamptz not null default now(),

  constraint purchase_items_quantity_positive check (quantity_ordered > 0),
  constraint purchase_items_received_non_negative check (quantity_received >= 0),
  -- Over-delivery is real and must be recordable, but a tenfold over-receipt is a
  -- keying error. 20% headroom accepts reality without accepting a typo.
  constraint purchase_items_received_within_tolerance check (quantity_received <= quantity_ordered * 1.2),
  constraint purchase_items_amounts_non_negative check (
    unit_cost >= 0 and discount_amount >= 0 and tax_amount >= 0 and line_total >= 0
  )
);

create unique index purchase_items_purchase_line_key on purchase_items (purchase_id, line_number);
create index purchase_items_product_idx on purchase_items (product_id, created_at desc);
create index purchase_items_purchase_idx on purchase_items (purchase_id);

comment on constraint purchase_items_received_within_tolerance on purchase_items is
  'Allows 20% over-delivery. Beyond that is a keying error, not a delivery.';

create table purchase_payments (
  id           uuid primary key default gen_random_uuid(),
  purchase_id  uuid not null references purchases (id) on delete cascade,
  tenant_id    uuid not null references tenants (id) on delete cascade,
  branch_id    uuid not null references branches (id) on delete cascade,

  method       payment_method not null,
  amount       app.money_minor not null,
  reference    text,
  paid_at      timestamptz not null default now(),
  paid_by      uuid references profiles (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint purchase_payments_amount_positive check (amount > 0),
  constraint purchase_payments_reference_required check (
    method not in ('MOMO', 'BANK_TRANSFER') or (reference is not null and length(btrim(reference)) > 0)
  )
);

create index purchase_payments_purchase_idx on purchase_payments (purchase_id);
create index purchase_payments_tenant_time_idx on purchase_payments (tenant_id, paid_at desc);

-- -----------------------------------------------------------------------------
-- Expenses
-- -----------------------------------------------------------------------------

create type expense_status as enum ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PAID');

create table expense_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        app.label not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index expense_categories_tenant_name_key on expense_categories (tenant_id, lower(name));

create trigger expense_categories_touch_updated_at
  before update on expense_categories
  for each row execute function app.touch_updated_at();

create table expenses (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  branch_id      uuid not null references branches (id) on delete restrict,
  category_id    uuid references expense_categories (id) on delete restrict,

  reference      text not null,
  description    app.label not null,
  amount         app.money_minor not null,

  method         payment_method not null default 'CASH',
  payment_reference text,
  -- Supabase Storage path to the receipt image.
  receipt_url    text,

  status         expense_status not null default 'APPROVED',

  -- The date the expense belongs to for reporting, which is not always the date it was
  -- entered - a receipt is often keyed in days later, and must land in the right month.
  expense_date   date not null default current_date,

  cash_session_id uuid,

  created_by     uuid not null references profiles (id) on delete restrict,
  approved_by    uuid references profiles (id) on delete set null,
  approved_at    timestamptz,
  rejected_reason text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint expenses_amount_positive check (amount > 0),
  constraint expenses_approval_documented check (status <> 'APPROVED' or approved_at is not null),
  constraint expenses_rejection_documented check (status <> 'REJECTED' or rejected_reason is not null),
  constraint expenses_reference_required check (
    method not in ('MOMO', 'BANK_TRANSFER') or (payment_reference is not null and length(btrim(payment_reference)) > 0)
  )
);

create unique index expenses_tenant_reference_key on expenses (tenant_id, reference);
create index expenses_branch_date_idx on expenses (branch_id, expense_date desc);
create index expenses_tenant_date_idx on expenses (tenant_id, expense_date desc);
create index expenses_category_idx on expenses (category_id, expense_date desc);
create index expenses_pending_idx on expenses (tenant_id) where status = 'PENDING_APPROVAL';

comment on column expenses.expense_date is
  'The date the expense belongs to for reporting. Often earlier than created_at; reports use this.';

create trigger expenses_touch_updated_at
  before update on expenses
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Cash register
--
-- ## What this is for
--
-- At the end of a shift someone counts the drawer. Carl must be able to say what should
-- be in it, so the difference can be investigated while the shift is still fresh.
--
--   expected = opening float
--            + cash sales
--            - cash refunds
--            + cash paid in
--            - cash paid out
--            - cash expenses
--
-- The variance is stored rather than computed on read, because it is a fact about that
-- shift. Recomputing it later against corrected data would erase the discrepancy that
-- was actually found - which is the only thing the record exists to preserve.
-- -----------------------------------------------------------------------------

create table cash_registers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  branch_id   uuid not null references branches (id) on delete cascade,
  name        app.label not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index cash_registers_branch_name_key on cash_registers (branch_id, lower(name));
create index cash_registers_tenant_idx on cash_registers (tenant_id);

create trigger cash_registers_touch_updated_at
  before update on cash_registers
  for each row execute function app.touch_updated_at();

create type cash_session_status as enum ('OPEN', 'CLOSED', 'RECONCILED');

create table cash_sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  branch_id         uuid not null references branches (id) on delete cascade,
  register_id       uuid not null references cash_registers (id) on delete restrict,
  device_id         uuid references devices (id) on delete set null,

  status            cash_session_status not null default 'OPEN',

  opening_float     app.money_minor not null default 0,
  -- Running totals, maintained by the sale, return and expense functions.
  cash_sales        app.money_minor not null default 0,
  cash_refunds      app.money_minor not null default 0,
  cash_in           app.money_minor not null default 0,
  cash_out          app.money_minor not null default 0,
  cash_expenses     app.money_minor not null default 0,

  expected_cash     app.money_minor,
  counted_cash      app.money_minor,
  -- counted - expected. Negative is short.
  variance          app.money_minor,
  variance_note     text,

  opened_by         uuid not null references profiles (id) on delete restrict,
  opened_at         timestamptz not null default now(),
  closed_by         uuid references profiles (id) on delete set null,
  closed_at         timestamptz,
  reconciled_by     uuid references profiles (id) on delete set null,
  reconciled_at     timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint cash_sessions_amounts_non_negative check (
    opening_float >= 0 and cash_sales >= 0 and cash_refunds >= 0
    and cash_in >= 0 and cash_out >= 0 and cash_expenses >= 0
  ),
  constraint cash_sessions_closed_is_counted check (
    status = 'OPEN' or (closed_at is not null and counted_cash is not null and expected_cash is not null)
  ),
  -- A shortfall must be explained. Silent variances are how theft goes unnoticed.
  constraint cash_sessions_variance_explained check (
    variance is null or variance = 0 or variance_note is not null
  )
);

-- One open session per register. Two would each record a partial view of the same
-- drawer, and neither would reconcile.
create unique index cash_sessions_one_open_per_register
  on cash_sessions (register_id)
  where status = 'OPEN';

create index cash_sessions_branch_idx on cash_sessions (branch_id, opened_at desc);
create index cash_sessions_tenant_idx on cash_sessions (tenant_id, opened_at desc);
create index cash_sessions_open_idx on cash_sessions (branch_id) where status = 'OPEN';

comment on column cash_sessions.variance is
  'counted - expected, in minor units. Negative is short. Stored, not recomputed: it is a fact about that shift.';

create trigger cash_sessions_touch_updated_at
  before update on cash_sessions
  for each row execute function app.touch_updated_at();

create type cash_movement_type as enum ('IN', 'OUT', 'DROP', 'PICKUP');

create table cash_movements (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references cash_sessions (id) on delete cascade,
  tenant_id    uuid not null references tenants (id) on delete cascade,
  branch_id    uuid not null references branches (id) on delete cascade,

  movement_type cash_movement_type not null,
  amount       app.money_minor not null,
  reason       app.label not null,
  notes        text,

  performed_by uuid not null references profiles (id) on delete restrict,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint cash_movements_amount_positive check (amount > 0)
);

create index cash_movements_session_idx on cash_movements (session_id, occurred_at);
create index cash_movements_tenant_idx on cash_movements (tenant_id, occurred_at desc);

-- Cash movements are evidence. Editing one after the fact would defeat the reconciliation
-- it exists to support.
create trigger cash_movements_immutable
  before update or delete on cash_movements
  for each row execute function app.reject_mutation();

-- -----------------------------------------------------------------------------
-- Deferred foreign keys
--
-- sales, sale_returns and expenses reference cash_sessions, which is defined here rather
-- than earlier. Adding the constraints now keeps each migration independently readable
-- without reordering the schema around a circular reference.
-- -----------------------------------------------------------------------------

alter table sales
  add constraint sales_cash_session_fk
  foreign key (cash_session_id) references cash_sessions (id) on delete set null;

alter table sale_returns
  add constraint sale_returns_cash_session_fk
  foreign key (cash_session_id) references cash_sessions (id) on delete set null;

alter table expenses
  add constraint expenses_cash_session_fk
  foreign key (cash_session_id) references cash_sessions (id) on delete set null;

create index sales_cash_session_idx on sales (cash_session_id) where cash_session_id is not null;
create index sale_returns_cash_session_idx on sale_returns (cash_session_id) where cash_session_id is not null;
create index expenses_cash_session_idx on expenses (cash_session_id) where cash_session_id is not null;
