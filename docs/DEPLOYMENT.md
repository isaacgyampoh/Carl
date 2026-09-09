# Deployment

> **Status.** The web application builds and runs. It has not been deployed to a live
> Supabase project — the current development machine has neither Docker nor a provisioned
> project. This document describes the intended path and is written to be followed, not to
> record something already done.

## Shape

```
  Vercel                Supabase                       Terminals
  ──────                ────────                       ─────────
  Next.js  ──────────►  PostgreSQL (RLS)      ◄──────  Carl Desktop
  Edge middleware       Auth                           (Tauri + SQLite)
                        Storage (receipts)
                        Connection pooler
```

## Before the first deploy

### 1. Create the Supabase project

Choose a region close to the customers. For a Ghanaian deployment that is `eu-west-1` or
`eu-central-1` — latency to a till matters more than it looks, because the cashier is
standing in front of someone.

### 2. Apply migrations

```bash
supabase link --project-ref <ref>
supabase db push
```

Then **run the database test suite against it** before letting anyone in:

```bash
CARL_TEST_DB_DRIVER=pg SUPABASE_DB_URL="<connection string>" pnpm test:db
```

This is the step that catches a divergence between the in-process test harness and a real
Supabase instance. It is not optional for a first deploy.

### 3. Configure Auth

In the Supabase dashboard:

- **Disable sign-ups.** Carl accounts are provisioned by the platform; self-registration
  would let anyone create a tenant. (`enable_signup = false` in `config.toml`.)
- Set the site URL and redirect URLs to the production origin.
- Set session timeout and inactivity timeout. A till is a shared device in a public place;
  the defaults in `config.toml` are 24h and 8h.

### 4. Environment variables on Vercel

| Variable                        | Scope      | Notes                                            |
| ------------------------------- | ---------- | ------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Public     | Compiled into the browser bundle                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public     | Safe **only** because RLS is enforced everywhere |
| `NEXT_PUBLIC_APP_URL`           | Public     | Canonical origin                                 |
| `SUPABASE_SERVICE_ROLE_KEY`     | **Secret** | Bypasses RLS entirely                            |
| `CARL_DEVICE_SECRET_PEPPER`     | **Secret** | `openssl rand -base64 48`                        |
| `SENTRY_DSN`                    | Secret     | Optional                                         |

**Generate a fresh pepper per environment, and never rotate it casually.** Every stored
device secret and activation code hash is derived from it; changing it invalidates every
activated terminal at once.

### 5. Create the first platform administrator

```sql
-- After creating the account through the Supabase Auth dashboard:
insert into platform_admins (user_id, note)
values ('<auth user id>', 'Initial platform administrator');
```

Platform administration is a table row rather than a flag on `profiles`, so there is no
privilege column on a self-editable record. See [SECURITY.md](SECURITY.md).

### 6. Connection pooling

Serverless functions open and discard connections rapidly. Use the **transaction pooler**
connection string (port 6543) for the application, and the direct connection (5432) only
for migrations.

Using the direct connection from Vercel will exhaust PostgreSQL's connection limit under
load, and it will do so at the busiest moment rather than the quietest.

## Deploying

```bash
vercel --prod
```

CI runs typecheck, lint, format, unit tests, database tests and the build before anything
merges. See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Provisioning a customer

```sql
select * from provision_tenant(
  'abc-trading',              -- slug, unique and permanent
  'ABC Trading Company',
  'owner@abctrading.com',
  'Ama Mensah',
  '<owner auth user id>',
  'Accra Branch',
  'accra',
  'TRIAL',
  14
);
```

One transaction creates the tenant, its first branch, all eight system roles with their
permissions, the owner membership, a cash register and an audit entry. A tenant with roles
but no permissions — the usual result of doing this by hand — is an account someone has to
repair.

Then, per terminal:

```sql
insert into devices (tenant_id, branch_id, code, name)
values ('<tenant>', '<branch>', 'pos-accra-001', 'Accra Till 1');

select * from issue_activation_code('<device id>', '<pepper>', 24);
```

The code is displayed **once**. See [DEVICE_ACTIVATION.md](DEVICE_ACTIVATION.md).

## Backups

Supabase takes daily backups on paid plans. For a system holding a shop's financial
records that is a floor, not a plan:

- Enable point-in-time recovery.
- **Test a restore before a customer needs one.** An untested backup is a hypothesis.
- The audit log and inventory ledger are append-only, so a restore to any point yields a
  self-consistent history rather than a partially-rewritten one.

## Monitoring

What is worth alerting on, in order of how much it costs to miss:

| Signal                                              | Why it matters                       |
| --------------------------------------------------- | ------------------------------------ |
| `sync_conflicts` with status `OPEN`                 | Offline sales nobody has adjudicated |
| Terminals with `health = 'OFFLINE'`                 | A till that has stopped reporting    |
| `authorized_until` approaching for an active device | It is about to stop selling          |
| Cash sessions closed with a variance                | A drawer that did not reconcile      |
| 5xx rate on `complete_sale`                         | Sales are failing at the till        |

The structured logger emits JSON lines with tenant, branch and device attached, so "which
terminal is failing to sync" is a query rather than an afternoon. Credentials are redacted
at any depth before anything is written.

## Rollback

Migrations are forward-only in production. To reverse a schema change, write a new
migration that undoes it — a `down` migration run against live data is how a mistake becomes
data loss.

The application can be rolled back independently on Vercel, which is usually the faster fix
and is safe as long as the schema change was additive.
