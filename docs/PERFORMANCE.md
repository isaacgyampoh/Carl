# Performance at a shop's second year

Carl is fast on a new shop. This records what happens when a shop has been trading for a year,
measured rather than guessed, and what was done about it.

## How to measure

`scripts/performance-probe.mjs` generates a year of trade — 10,000 products, 100,000 sales,
500,000 line items, 100,000 stock movements — and runs the queries a shop actually waits on,
**as an authenticated cashier**, so Row Level Security is in every plan. A measurement taken as
the database owner skips the security layer and describes a system Carl does not ship.

It writes hundreds of thousands of rows and does not clean up, so it refuses to run without
`CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes` and belongs on **staging**, never production:

```bash
set -a; . ~/.carl/staging.env; set +a
CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes pnpm run db:perf

# Measure the volume that is already there — six minutes cheaper, and what you want
# when comparing before and after a change.
CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes CARL_PERF_REUSE=yes pnpm run db:perf
```

Each query is measured on its own connection with its own timeout (`CARL_PERF_TIMEOUT_MS`,
60s by default). A query slow enough to be disconnected by the server is then a reported
finding rather than the end of the run — which is how the first version of this probe lost
the nine measurements after its third query.

## What it found, and what fixed it (2026-09-11, staging, micro instance)

| Query                            | Budget   | Before           | After      |
| -------------------------------- | -------- | ---------------- | ---------- |
| Barcode scan                     | 50 ms    | 3.9 ms           | 0.9 ms     |
| Product search by name           | 200 ms   | 6,184.7 ms       | 18.1 ms    |
| Sales list, first page           | 200 ms   | 98,934.5 ms      | 71.1 ms    |
| Today's takings                  | 400 ms   | 531.0 ms         | 6.0 ms     |
| Low stock                        | 400 ms   | 2.6 ms           | 1.9 ms     |
| Inventory ledger for one product | 300 ms   | 5,628.6 ms       | 9.0 ms     |
| Best sellers over a year         | 5,000 ms | no answer in 60s | 1,193.7 ms |

2 of 7 within budget, then 7 of 7. The sales list — the screen a shop opens most — went from
99 seconds to 71 milliseconds on the same data, same instance, same security rules.

## Why it was slow

Not a missing index. The indexes were all there, including a trigram index on `products.name`
and `sales (tenant_id, sold_at desc)`, and the planner was using none of them.

Every read policy asked a question **about each row**: `app.can_read(sales.tenant_id,
'sales.view_all', sales.branch_id)`. Two things follow from that:

1. PostgreSQL cannot drive an index from a function call whose arguments are columns, because
   it is not a comparison against a constant.
2. The helper is not `LEAKPROOF`, so the security check must be evaluated **before** ordinary
   filters — before `name ilike $1`, before `sold_at >= $1`. Every row is examined, and three
   membership and permission lookups run for each one.

On `sales` it was worse: two permissive SELECT policies, ORed together by PostgreSQL, which
removed the last chance of an index-driven plan.

## What fixed it

`supabase/migrations/20260101004300_readable_sets.sql`: ask the expensive question once per
statement instead of once per row.

```sql
using (tenant_id = any (coalesce((select app.readable_tenant_ids('products.view')), array[]::uuid[])))
```

`app.readable_tenant_ids(permission)` and `app.readable_branch_ids(permission)` return what the
caller may read. The sub-SELECT is planned as an InitPlan — resolved once and substituted as a
parameter — so the policy each row actually meets is `tenant_id = any($0)`. A uuid `=` is
leakproof, so the planner is free to apply the user's own filters first and to use any index it
likes. The two policies on `sales` were folded into one.

Three things keep that from being a security change:

- **The sets are built by calling `app.can_read` itself**, over the caller's own memberships and
  support grants, so they cannot drift from the rule the rest of the schema enforces.
- **`tests/db/readable-sets.test.ts`** asserts the equivalence directly — every combination of
  five people, two businesses, three branches and five permissions — so a future edit that makes
  a set disagree with `app.can_read` fails the build.
- **A row's branch now has to belong to the row's tenant.** The equivalence depends on it, and
  nothing enforced it before: `sales`, `sale_items` and `inventory_movements` each gained a
  composite foreign key to `branches (tenant_id, id)`.

The full suite of 610 database and RLS tests passes unchanged, including multi-tenant isolation.

## What is still worth doing

- The same treatment for the remaining tables whose policies call `app.can_read` per row
  (`customers`, `expenses`, `purchases`, `transfers`, and others). None of them is near the
  volume that made `sales` unusable, and each should be measured before and after rather than
  changed on faith.
- `LEAKPROOF` helpers, which would let PostgreSQL apply ordinary filters first everywhere.
  Marking a function leakproof requires superuser, which a hosted Supabase project does not
  grant, so this needs Supabase's involvement.
