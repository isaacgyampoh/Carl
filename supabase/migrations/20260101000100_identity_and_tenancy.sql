-- =============================================================================
-- 0001 · Identity, tenancy and membership
--
-- The foundation of Carl's multi-tenancy. Every tenant-owned table in every later
-- migration carries a tenant_id and every RLS policy resolves through the membership
-- tables defined here.
--
-- ## The model
--
--   auth.users            Supabase-managed credentials (never written by Carl directly)
--        │ 1:1
--   profiles              Carl's view of a person; platform-admin flag lives here
--        │ 1:N
--   tenant_memberships    "this person works for this business"
--        │ 1:N
--   membership_branches   "...and may act in these branches"
--
-- A person can belong to more than one tenant (an accountant serving several shops), so
-- membership is a join table, not a column on the profile.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enumerations
--
-- Enums rather than text + CHECK: a typo becomes an error at write time, and the set of
-- valid values is discoverable from the schema.
-- -----------------------------------------------------------------------------

create type tenant_status as enum (
  'TRIAL',
  'ACTIVE',
  'GRACE_PERIOD',   -- payment overdue; still operating, warned
  'SUSPENDED',      -- non-payment or abuse; may not transact
  'CANCELLED'       -- ended; retained read-only for the statutory period
);

create type membership_status as enum (
  'INVITED',
  'ACTIVE',
  'SUSPENDED',
  'REMOVED'
);

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

create table profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  email            extensions.citext not null,
  full_name        app.label not null,
  phone            text,
  avatar_url       text,

  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint profiles_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

create unique index profiles_email_key on profiles (email);

comment on table profiles is 'A person who can sign in to Carl. One row per auth.users row.';

create trigger profiles_touch_updated_at
  before update on profiles
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- platform_admins
--
-- ## Why this is a table rather than a column on `profiles`
--
-- It began as `profiles.is_platform_admin`, and that was wrong for two reasons.
--
-- **Escalation surface.** A user can update their own profile row. Preventing them from
-- also flipping a privilege column on it requires a policy that inspects the row's
-- current value — which means a policy on `profiles` that reads `profiles`. PostgreSQL
-- refuses that outright (42P17, infinite recursion), and the same recursion would have
-- broken every legitimate profile update. Moving the flag out means there is simply no
-- privilege column on the row a user controls.
--
-- **Auditability.** Platform administration should record who granted it and when.
-- A boolean cannot.
--
-- Note what this still does NOT confer: access to any tenant's business data. That needs
-- a `tenant_support_grants` row. See migration 0009.
-- -----------------------------------------------------------------------------

create table platform_admins (
  user_id    uuid primary key references profiles (id) on delete cascade,
  granted_by uuid references profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  note       text
);

comment on table platform_admins is
  'Administers the Carl platform. Deliberately not a column on profiles - see the migration note.';

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------

create table tenants (
  id                   uuid primary key default gen_random_uuid(),
  slug                 app.slug not null,
  name                 app.label not null,
  legal_name           text,
  status               tenant_status not null default 'TRIAL',

  -- Contact and locale
  email                extensions.citext,
  phone                text,
  address              text,
  country_code         char(2) not null default 'GH',
  currency_code        char(3) not null default 'GHS',
  timezone             text not null default 'Africa/Accra',

  -- Presentation
  logo_url             text,
  receipt_footer       text,

  -- Tax. Carl records the rate a tenant is registered for; it does not file returns.
  tax_registration_no  text,
  default_tax_rate     app.percentage not null default 0,
  prices_include_tax   boolean not null default true,

  -- Lifecycle. trial_ends_at and grace ending drive the status transitions applied by
  -- the platform, and are read by device authorization checks.
  trial_ends_at        timestamptz,
  suspended_at         timestamptz,
  suspension_reason    text,
  cancelled_at         timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint tenants_currency_format check (currency_code ~ '^[A-Z]{3}$'),
  constraint tenants_country_format check (country_code ~ '^[A-Z]{2}$'),
  -- A suspended tenant must record why and when. Without this, "why is this shop locked
  -- out" becomes unanswerable at exactly the moment it is urgent.
  constraint tenants_suspension_documented check (
    status <> 'SUSPENDED' or (suspended_at is not null and suspension_reason is not null)
  ),
  constraint tenants_cancellation_dated check (
    status <> 'CANCELLED' or cancelled_at is not null
  )
);

create unique index tenants_slug_key on tenants (slug);
create index tenants_status_idx on tenants (status) where status <> 'ACTIVE';

comment on table tenants is 'A business using Carl. The root of every ownership chain.';
comment on column tenants.prices_include_tax is
  'Whether the retail price already includes tax (the norm in Ghana) or tax is added at checkout.';

create trigger tenants_touch_updated_at
  before update on tenants
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- branches
-- -----------------------------------------------------------------------------

create table branches (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  code           app.slug not null,
  name           app.label not null,

  address        text,
  phone          text,
  timezone       text,

  -- Exactly one branch per tenant is the default, used when a caller does not specify one.
  is_default     boolean not null default false,
  is_active      boolean not null default true,

  -- Whether this branch may sell stock it does not have. Off by default: a POS that
  -- silently sells air produces inventory that cannot be reconciled. Some businesses
  -- genuinely need it (services, made-to-order), so it is a per-branch setting rather
  -- than a global assumption.
  allow_negative_stock boolean not null default false,

  opened_at      timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint branches_closed_after_opened check (closed_at is null or opened_at is null or closed_at >= opened_at)
);

-- Branch codes are unique per tenant, not globally: two different businesses may both
-- have an "ACCRA" branch, and forcing global uniqueness would leak the existence of
-- other tenants' branches through collision errors.
create unique index branches_tenant_code_key on branches (tenant_id, code);
create index branches_tenant_idx on branches (tenant_id) where is_active;

-- At most one default branch per tenant, enforced by a partial unique index rather than
-- application logic, so a concurrent write cannot produce two.
create unique index branches_one_default_per_tenant on branches (tenant_id) where is_default;

comment on table branches is 'A physical location. Inventory, sales and cash are all branch-scoped.';
comment on column branches.allow_negative_stock is
  'Permits selling below zero stock. Off by default; a POS that sells air cannot be reconciled.';

create trigger branches_touch_updated_at
  before update on branches
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- tenant_memberships
-- -----------------------------------------------------------------------------

create table tenant_memberships (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  user_id       uuid not null references profiles (id) on delete cascade,
  status        membership_status not null default 'INVITED',

  -- The owner is the one member who cannot be removed by another member, and who
  -- receives the account if every administrator leaves.
  is_owner      boolean not null default false,

  -- Employment details, kept here rather than on the profile because the same person may
  -- have different details at different tenants.
  staff_code    text,
  job_title     text,

  invited_by    uuid references profiles (id) on delete set null,
  invited_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  suspended_at  timestamptz,
  removed_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint memberships_active_is_accepted check (status <> 'ACTIVE' or accepted_at is not null)
);

create unique index tenant_memberships_tenant_user_key on tenant_memberships (tenant_id, user_id);
create unique index tenant_memberships_staff_code_key
  on tenant_memberships (tenant_id, staff_code)
  where staff_code is not null;

-- The hot path for every RLS check: "which tenants may this user reach". Partial, because
-- only ACTIVE membership grants anything, and the index stays small as staff turn over.
create index tenant_memberships_active_user_idx
  on tenant_memberships (user_id, tenant_id)
  where status = 'ACTIVE';

create index tenant_memberships_tenant_idx on tenant_memberships (tenant_id, status);

-- Exactly one owner per tenant.
create unique index tenant_memberships_one_owner_per_tenant
  on tenant_memberships (tenant_id)
  where is_owner and status = 'ACTIVE';

comment on table tenant_memberships is
  'Links a person to a business. A person may belong to several tenants, so this is a join table.';

create trigger tenant_memberships_touch_updated_at
  before update on tenant_memberships
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- membership_branches
--
-- Which branches a member may act in.
--
-- Absence of rows means tenant-wide access, which is the correct default for an owner or
-- administrator and avoids having to fan out a row per branch every time a branch is
-- created. Presence of rows restricts the member to exactly those branches.
-- -----------------------------------------------------------------------------

create table membership_branches (
  membership_id uuid not null references tenant_memberships (id) on delete cascade,
  branch_id     uuid not null references branches (id) on delete cascade,
  created_at    timestamptz not null default now(),

  primary key (membership_id, branch_id)
);

create index membership_branches_branch_idx on membership_branches (branch_id);

comment on table membership_branches is
  'Restricts a member to specific branches. No rows means tenant-wide access.';
