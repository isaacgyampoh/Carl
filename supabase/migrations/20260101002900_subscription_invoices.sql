-- =============================================================================
-- 0029 · Subscription invoices
--
-- What Carl sends a merchant to ask for the subscription fee, and the record of whether
-- they paid it.
--
-- ## Scope
--
-- Deliberately small. This is not an accounting system: there are no line items, no tax
-- computation, no credit notes, no ledger. A Carl subscription invoice is one amount for
-- one billing period, and inventing more structure now would be inventing requirements.
--
-- Money owed is still answered by `subscriptions` (period, price, grace) and money
-- received by `subscription_payments`. An invoice is the document that connects them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Who to ring about the money.
--
-- `tenants` already carries email, phone and address, but not the name of the person the
-- platform owner actually speaks to. Chasing a subscription payment means asking for
-- someone by name, and keeping that in a notes field means it is not searchable and not
-- reliably present.
-- -----------------------------------------------------------------------------
alter table tenants add column if not exists contact_person text;

comment on column tenants.contact_person is
  'The person the platform owner deals with. Not a user account, and not an authorisation subject.';

create type invoice_status as enum (
  'DRAFT',      -- being prepared; may still be changed or discarded
  'ISSUED',     -- sent to the merchant; the amount is now fixed
  'PAID',       -- settled by a recorded subscription payment
  'OVERDUE',    -- past its due date and unpaid
  'CANCELLED'   -- withdrawn; never collectable
);

-- -----------------------------------------------------------------------------
-- Invoice numbers
--
-- A sequence rather than count-and-increment. Invoice numbers are platform-wide, so the
-- per-branch "lock the parent row and count" approach used for receipt numbers has no
-- parent to lock; two invoices issued in the same moment would derive the same number.
-- A sequence cannot do that.
--
-- The trade-off is honest: a sequence does not roll back, so an aborted transaction
-- leaves a gap. Gaps are acceptable in this ledger — every number that exists is unique
-- and monotonic, which is what matters for referring to an invoice. Gapless numbering
-- would require serialising all issuance behind a lock, which buys nothing here.
-- -----------------------------------------------------------------------------
create sequence subscription_invoice_number_seq;

create or replace function app.next_invoice_number(p_at timestamptz default null)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'CARL-' || to_char(coalesce(p_at, now()), 'YYYY') || '-'
         || lpad(nextval('public.subscription_invoice_number_seq')::text, 6, '0')
$$;

comment on function app.next_invoice_number(timestamptz) is
  'Platform-wide invoice number. Unique and monotonic; may contain gaps, which is intended.';

create table subscription_invoices (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  text not null,
  tenant_id       uuid not null references tenants (id) on delete cascade,
  -- Restricted rather than cascaded: deleting a subscription must not silently destroy the
  -- record of what was billed under it.
  subscription_id uuid not null references subscriptions (id) on delete restrict,

  period_start    timestamptz not null,
  period_end      timestamptz not null,

  amount          app.money_minor not null,
  currency_code   char(3) not null default 'GHS',

  status          invoice_status not null default 'DRAFT',
  issued_at       timestamptz,
  due_at          timestamptz not null,
  paid_at         timestamptz,
  -- The payment that settled it. Null until paid, and null again if that payment is ever
  -- found to be in error.
  paid_by_payment_id uuid references subscription_payments (id) on delete set null,

  cancelled_at    timestamptz,
  cancel_reason   text,
  notes           text,

  -- Attribution without a foreign key, matching the ledger tables: the platform
  -- administrator who issued an invoice may later leave, and the invoice must survive them.
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint subscription_invoices_amount_positive check (amount > 0),
  constraint subscription_invoices_period_ordered check (period_end > period_start),
  -- An issued invoice has an issue date. Without this, "issued" is a label rather than a
  -- fact, and no one can say when the merchant was actually asked to pay.
  constraint subscription_invoices_issue_dated check (
    status = 'DRAFT' or status = 'CANCELLED' or issued_at is not null
  ),
  constraint subscription_invoices_payment_dated check (
    (status = 'PAID') = (paid_at is not null)
  ),
  constraint subscription_invoices_cancellation_documented check (
    status <> 'CANCELLED' or (cancelled_at is not null and cancel_reason is not null)
  )
);

create unique index subscription_invoices_number_key on subscription_invoices (invoice_number);
create index subscription_invoices_tenant_idx on subscription_invoices (tenant_id, created_at desc);
create index subscription_invoices_subscription_idx on subscription_invoices (subscription_id);
-- The billing screen's query: what is unpaid, soonest due first.
create index subscription_invoices_due_idx on subscription_invoices (due_at)
  where status in ('ISSUED', 'OVERDUE');

-- One invoice per subscription per billing period. Issuing the same period twice is the
-- mistake that produces a merchant with two bills for the same month.
create unique index subscription_invoices_period_key
  on subscription_invoices (subscription_id, period_start, period_end)
  where status <> 'CANCELLED';

create trigger subscription_invoices_updated_at
  before update on subscription_invoices
  for each row execute function app.touch_updated_at();

alter table subscription_invoices enable row level security;
alter table subscription_invoices force row level security;

-- -----------------------------------------------------------------------------
-- Who may read an invoice
--
-- The platform, and the merchant it was sent to. A business is entitled to see what it has
-- been billed; it is not entitled to see anybody else's bill.
--
-- There is no write policy at all. Invoices are created and settled by the functions in
-- migration 0030, which check authorisation, enforce the rules and write an audit entry.
-- -----------------------------------------------------------------------------
create policy subscription_invoices_select_platform_admin on subscription_invoices
  for select to authenticated
  using ((select app.is_platform_admin()));

-- Mirrors the `subscriptions` policy exactly, rather than inventing a permission: a
-- merchant sees their own invoices on the same terms they see their own subscription.
create policy subscription_invoices_select_tenant on subscription_invoices
  for select to authenticated
  using (
    (select app.is_tenant_owner(subscription_invoices.tenant_id))
    or (select app.has_permission(subscription_invoices.tenant_id, 'settings.manage'))
  );

comment on table subscription_invoices is
  'What Carl billed a merchant for a subscription period. Written only by platform operations.';
