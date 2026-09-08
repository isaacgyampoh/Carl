-- =============================================================================
-- 0009 · Platform administration
--
-- Carl is sold, installed and maintained as a commercial service, so the platform needs
-- records of its own: who is subscribed, what they have paid, which sites have been
-- installed, and what has gone wrong since.
--
-- These tables belong to the Carl platform, not to any tenant. No tenant user can read
-- them (enforced by RLS in migration 0011).
--
-- ## Support access is deliberately narrow
--
-- The obvious design is to let a platform admin read everything. That is also how a
-- support engineer ends up able to read every shop's daily takings, silently, forever.
--
-- Instead `tenant_support_grants` records an explicit, time-boxed, reasoned grant per
-- tenant. Support access therefore has a start, an end, a stated reason and an audit
-- trail - and a customer can be told exactly when their data was accessed and why.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Subscriptions
-- -----------------------------------------------------------------------------

create type subscription_status as enum ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');
create type billing_interval as enum ('MONTHLY', 'QUARTERLY', 'ANNUAL');

create table subscription_plans (
  id                uuid primary key default gen_random_uuid(),
  key               app.slug not null,
  name              app.label not null,
  description       text,

  price             app.money_minor not null default 0,
  currency_code     char(3) not null default 'GHS',
  interval          billing_interval not null default 'MONTHLY',

  -- NULL means unlimited. Enforced when provisioning, so a plan limit is a real
  -- constraint rather than a marketing line.
  max_branches      integer,
  max_devices       integer,
  max_users         integer,

  features          jsonb not null default '{}'::jsonb,
  is_active         boolean not null default true,
  sort_order        integer not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint subscription_plans_price_non_negative check (price >= 0),
  constraint subscription_plans_limits_positive check (
    (max_branches is null or max_branches > 0)
    and (max_devices is null or max_devices > 0)
    and (max_users is null or max_users > 0)
  )
);

create unique index subscription_plans_key_key on subscription_plans (key);

create trigger subscription_plans_touch_updated_at
  before update on subscription_plans
  for each row execute function app.touch_updated_at();

create table subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  plan_id            uuid not null references subscription_plans (id) on delete restrict,

  status             subscription_status not null default 'TRIALING',

  -- The price this tenant actually pays, which may differ from the plan's list price.
  -- Copied at signup so a later plan price change does not silently reprice an existing
  -- customer.
  price              app.money_minor not null,
  currency_code      char(3) not null default 'GHS',
  interval           billing_interval not null default 'MONTHLY',

  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null,
  -- How long after the period ends the tenant keeps operating while payment is chased.
  grace_days         smallint not null default 7,

  trial_ends_at      timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,

  notes              text,
  created_by         uuid references profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint subscriptions_period_ordered check (current_period_end > current_period_start),
  constraint subscriptions_price_non_negative check (price >= 0),
  constraint subscriptions_grace_bounded check (grace_days between 0 and 90)
);

-- One live subscription per tenant. Two would make "is this tenant paid up" ambiguous.
create unique index subscriptions_one_live_per_tenant
  on subscriptions (tenant_id)
  where status <> 'CANCELLED';

create index subscriptions_status_idx on subscriptions (status);
-- The renewals-due view.
create index subscriptions_period_end_idx on subscriptions (current_period_end) where status in ('ACTIVE', 'PAST_DUE');

comment on column subscriptions.price is
  'The price this tenant pays. Copied from the plan at signup so a list-price change does not reprice them.';

create trigger subscriptions_touch_updated_at
  before update on subscriptions
  for each row execute function app.touch_updated_at();

-- Payments are recorded manually by a Carl administrator; there is no payment gateway
-- integration. The schema is shaped so one can be added later without migrating history.
create table subscription_payments (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid not null references subscriptions (id) on delete cascade,
  tenant_id        uuid not null references tenants (id) on delete cascade,

  amount           app.money_minor not null,
  currency_code    char(3) not null default 'GHS',
  method           payment_method not null default 'BANK_TRANSFER',
  reference        text,

  period_start     timestamptz not null,
  period_end       timestamptz not null,

  paid_at          timestamptz not null default now(),
  -- The Carl staff member who recorded it. Required: a payment record with no author is
  -- not auditable.
  recorded_by      uuid not null references profiles (id) on delete restrict,
  notes            text,

  created_at       timestamptz not null default now(),

  constraint subscription_payments_amount_positive check (amount > 0),
  constraint subscription_payments_period_ordered check (period_end > period_start)
);

create index subscription_payments_subscription_idx on subscription_payments (subscription_id, paid_at desc);
create index subscription_payments_tenant_idx on subscription_payments (tenant_id, paid_at desc);

-- A recorded payment is a financial record. Corrections are made by recording a
-- compensating entry, not by editing history.
create trigger subscription_payments_immutable
  before update or delete on subscription_payments
  for each row execute function app.reject_mutation();

-- -----------------------------------------------------------------------------
-- Installation and maintenance
-- -----------------------------------------------------------------------------

create type installation_status as enum ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

create table installations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  branch_id      uuid references branches (id) on delete set null,

  reference      text not null,
  status         installation_status not null default 'SCHEDULED',

  scheduled_for  timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,

  installer_id   uuid references profiles (id) on delete set null,
  installer_name text,
  location       text,

  device_count   integer not null default 0,
  configuration  jsonb not null default '{}'::jsonb,
  notes          text,
  -- Signed handover, stored in Supabase Storage.
  signoff_url    text,

  created_by     uuid references profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint installations_device_count_non_negative check (device_count >= 0),
  constraint installations_completion_dated check (status <> 'COMPLETED' or completed_at is not null)
);

create unique index installations_reference_key on installations (reference);
create index installations_tenant_idx on installations (tenant_id, created_at desc);
create index installations_status_idx on installations (status, scheduled_for);

create trigger installations_touch_updated_at
  before update on installations
  for each row execute function app.touch_updated_at();

create type maintenance_status as enum ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');
create type maintenance_priority as enum ('LOW', 'NORMAL', 'HIGH', 'URGENT');

create table maintenance_records (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  branch_id      uuid references branches (id) on delete set null,
  device_id      uuid references devices (id) on delete set null,

  reference      text not null,
  status         maintenance_status not null default 'OPEN',
  priority       maintenance_priority not null default 'NORMAL',

  issue          app.label not null,
  description    text,
  resolution     text,

  reported_by    uuid references profiles (id) on delete set null,
  reporter_name  text,
  technician_id  uuid references profiles (id) on delete set null,

  reported_at    timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at    timestamptz,
  closed_at      timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A ticket cannot be resolved without saying how. Otherwise the same fault is
  -- diagnosed from scratch next time.
  constraint maintenance_resolution_documented check (
    status not in ('RESOLVED', 'CLOSED') or (resolved_at is not null and resolution is not null)
  )
);

create unique index maintenance_reference_key on maintenance_records (reference);
create index maintenance_tenant_idx on maintenance_records (tenant_id, reported_at desc);
create index maintenance_open_idx on maintenance_records (status, priority, reported_at) where status <> 'CLOSED';
create index maintenance_device_idx on maintenance_records (device_id, reported_at desc) where device_id is not null;
create index maintenance_technician_idx on maintenance_records (technician_id, status) where technician_id is not null;

create trigger maintenance_touch_updated_at
  before update on maintenance_records
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- tenant_support_grants
--
-- Explicit, time-boxed permission for a named Carl staff member to read one tenant's
-- business data. See the header note for why this is not simply implied by
-- a row in `platform_admins`.
-- -----------------------------------------------------------------------------

create table tenant_support_grants (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  grantee_id   uuid not null references profiles (id) on delete cascade,

  reason       app.label not null,
  -- The maintenance ticket this access relates to, so the grant can be justified later.
  maintenance_id uuid references maintenance_records (id) on delete set null,

  -- Read-only by default. Write access to a customer's live data is a separate, rarer
  -- decision and must be asked for deliberately.
  allow_write  boolean not null default false,

  granted_by   uuid not null references profiles (id) on delete restrict,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,

  created_at   timestamptz not null default now(),

  constraint support_grants_expiry_after_grant check (expires_at > granted_at),
  -- Support access measured in weeks is standing access with extra steps.
  constraint support_grants_window_bounded check (expires_at <= granted_at + interval '7 days')
);

create index support_grants_active_idx
  on tenant_support_grants (grantee_id, tenant_id, expires_at)
  where revoked_at is null;

create index support_grants_tenant_idx on tenant_support_grants (tenant_id, granted_at desc);

comment on table tenant_support_grants is
  'Time-boxed, reasoned support access to one tenant. Platform admin alone does not grant data access.';
