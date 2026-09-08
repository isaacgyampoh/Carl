-- =============================================================================
-- 0008 · Audit log, idempotency and offline synchronisation
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_logs
--
-- ## Append-only, and enforced
--
-- An audit log that a tenant administrator can edit is worthless precisely when it
-- matters - after someone has done something they would rather not be recorded. The
-- trigger below refuses UPDATE and DELETE outright, so history cannot be rewritten
-- through the API, through psql, or by a support script.
--
-- Retention is handled by partition drop at the platform level, never by deletion.
-- -----------------------------------------------------------------------------

create table audit_logs (
  id           uuid primary key default gen_random_uuid(),

  -- Nullable: platform-level actions (creating a tenant, signing in) precede or sit
  -- outside any tenant.
  tenant_id    uuid references tenants (id) on delete cascade,
  branch_id    uuid references branches (id) on delete set null,

  -- The actor is NOT cascaded on delete. A deleted employee's actions must remain
  -- attributable, so the id survives the profile.
  actor_id     uuid,
  actor_email  text,
  actor_name   text,

  action       text not null,
  entity_type  text,
  entity_id    uuid,

  -- Before/after state. Kept as jsonb rather than columns because the shape differs per
  -- entity, and the log must not need a migration every time a table gains a column.
  before_state jsonb,
  after_state  jsonb,
  metadata     jsonb not null default '{}'::jsonb,

  device_id    uuid references devices (id) on delete set null,
  ip_address   inet,
  user_agent   text,
  request_id   uuid,

  occurred_at  timestamptz not null default now(),

  constraint audit_logs_action_format check (action ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

create index audit_logs_tenant_time_idx on audit_logs (tenant_id, occurred_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id, occurred_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_action_idx on audit_logs (tenant_id, action, occurred_at desc);
create index audit_logs_device_idx on audit_logs (device_id, occurred_at desc) where device_id is not null;

comment on table audit_logs is
  'Append-only record of consequential actions. UPDATE and DELETE are refused by trigger.';
comment on column audit_logs.actor_id is
  'Not a foreign key: a departed employee''s actions must stay attributable after their profile is removed.';

create trigger audit_logs_immutable
  before update or delete on audit_logs
  for each row execute function app.reject_mutation();

-- -----------------------------------------------------------------------------
-- idempotency_keys
--
-- ## The problem
--
-- A cashier taps Complete. The request reaches the server, the sale is written, the
-- response is lost to a dropped connection. The client retries. Without protection the
-- customer is charged twice and stock falls twice.
--
-- Offline sync makes this certain rather than merely likely: a terminal replays its queue
-- after reconnecting, and a partially-acknowledged batch is re-sent by design.
--
-- ## The mechanism
--
-- The client generates a key once per logical operation and reuses it for every retry.
-- The server records the key with the result. A second arrival returns the original
-- outcome without performing the work again.
--
-- The unique index is what actually enforces this. Two concurrent retries both attempt
-- the insert; exactly one succeeds and the other is told the operation already exists.
-- Checking-then-inserting in application code would leave a race between the two.
--
-- ## request_fingerprint
--
-- Guards against a key being reused for a *different* request - accidentally, or as an
-- attempt to have a cheap sale's response returned in place of an expensive one.
-- -----------------------------------------------------------------------------

create type idempotency_status as enum ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

create table idempotency_keys (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,

  key                 text not null,
  operation           text not null,
  request_fingerprint text not null,

  status              idempotency_status not null default 'IN_PROGRESS',

  -- The identifier the original attempt produced, returned verbatim on replay.
  result_id           uuid,
  result              jsonb,
  error_code          text,

  device_id           uuid references devices (id) on delete set null,
  user_id             uuid references profiles (id) on delete set null,

  -- Keys are retained well beyond any plausible retry window, then pruned. Too short and
  -- a terminal that was offline for a fortnight replays its queue as new sales.
  expires_at          timestamptz not null default (now() + interval '30 days'),
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,

  constraint idempotency_keys_format check (key ~ '^[A-Za-z0-9_-]{16,128}$'),
  constraint idempotency_keys_terminal_state_has_outcome check (
    status = 'IN_PROGRESS' or completed_at is not null
  )
);

-- Scoped per tenant and operation: one tenant's key cannot collide with another's, and a
-- key reused across different operations is a different logical request.
create unique index idempotency_keys_scope_key on idempotency_keys (tenant_id, operation, key);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);
create index idempotency_keys_device_idx on idempotency_keys (device_id, created_at desc) where device_id is not null;

comment on table idempotency_keys is
  'Makes every critical write safe to retry. The unique index is the enforcement; application checks would race.';

-- -----------------------------------------------------------------------------
-- sync_conflicts
--
-- ## Why conflicts are stored rather than resolved silently
--
-- Two terminals go offline holding 10 units. One sells 8, the other sells 7. Both
-- transactions are legitimate from the terminal's point of view, and both arrive later.
--
-- Carl must not pretend 15 units existed. Nor may it discard the second sale - the
-- customer took the goods and paid. So the sale is recorded and the conflict is raised
-- for a human: someone must decide whether stock was miscounted, whether an item was
-- oversold and must be sourced, or whether a refund is owed.
--
-- Silently absorbing this is how a POS ends up with inventory nobody believes.
-- -----------------------------------------------------------------------------

create type sync_conflict_type as enum (
  'INSUFFICIENT_STOCK',
  'PRICE_CHANGED',
  'PRODUCT_REMOVED',
  'DUPLICATE_TRANSACTION',
  'DEVICE_REVOKED',
  'TENANT_SUSPENDED',
  'VALIDATION_FAILED'
);

create type sync_conflict_status as enum ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

create table sync_conflicts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  branch_id      uuid references branches (id) on delete set null,
  device_id      uuid references devices (id) on delete set null,

  conflict_type  sync_conflict_type not null,
  status         sync_conflict_status not null default 'OPEN',

  entity_type    text not null,
  entity_id      uuid,
  -- The transaction as the terminal recorded it, kept verbatim so a reviewer can see
  -- what the cashier actually did rather than an interpretation of it.
  payload        jsonb not null,
  detail         text not null,

  resolved_by    uuid references profiles (id) on delete set null,
  resolved_at    timestamptz,
  resolution_note text,

  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  constraint sync_conflicts_resolution_documented check (
    status not in ('RESOLVED', 'DISMISSED') or (resolved_at is not null and resolution_note is not null)
  )
);

-- The "needs attention" queue, which is the only view that matters day to day.
create index sync_conflicts_open_idx on sync_conflicts (tenant_id, occurred_at desc) where status = 'OPEN';
create index sync_conflicts_device_idx on sync_conflicts (device_id, occurred_at desc);
create index sync_conflicts_branch_idx on sync_conflicts (branch_id, status);

comment on table sync_conflicts is
  'Offline transactions the server could not accept as-is. Surfaced to staff, never silently dropped.';

-- -----------------------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------------------

create type notification_severity as enum ('INFO', 'WARNING', 'CRITICAL');

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  branch_id    uuid references branches (id) on delete cascade,
  -- NULL means the notification is for anyone with the relevant permission rather than
  -- one named person.
  user_id      uuid references profiles (id) on delete cascade,

  kind         text not null,
  severity     notification_severity not null default 'INFO',
  title        app.label not null,
  body         text,
  link         text,
  metadata     jsonb not null default '{}'::jsonb,

  read_at      timestamptz,
  created_at   timestamptz not null default now(),

  constraint notifications_kind_format check (kind ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

create index notifications_user_unread_idx on notifications (user_id, created_at desc) where read_at is null;
create index notifications_tenant_idx on notifications (tenant_id, created_at desc);
