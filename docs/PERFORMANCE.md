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

## A correction to what this document used to say

An earlier version of this page reported the sales list going from **98,934 ms to 71 ms**.
That number was real, and it measured a query Carl never sends.

The probe asked `select ... from sales order by sold_at desc limit 50` — with no `tenant_id`
filter. Every screen in Carl applies one (`.eq('tenant_id', auth.tenant.tenantId)`); it is not
the security control, but it is always there, and it is what lets the planner use
`sales (tenant_id, sold_at desc)`. Without it there was nothing to index on, so the old policy
had to examine every sale on the platform. With it, the old policy was already fast for the
common case.

The probe now sends the queries the screens send. The figures below replace the old ones.

## What the change is actually worth (2026-09-14)

Measured on 20,000 sales in PGlite, as the person who opens the screen, best of three runs,
old policy against new:

| Query, as Carl's screen sends it         | Before       | After       |
| ---------------------------------------- | ------------ | ----------- |
| Sales list, first page, as a manager     | 6.4 ms       | 0.7 ms      |
| **The exact row count beside that list** | **2,016 ms** | **10.8 ms** |
| **Sales list, first page, as a cashier** | **2,278 ms** | **6.0 ms**  |
| Today's takings                          | 73.1 ms      | 0.7 ms      |
| Product search by name                   | 1.5 ms       | 0.1 ms      |

The first page for a manager was never the problem: an index handed it the newest fifty rows
and the policy ran fifty times. The damage was in the two queries that have to touch every row
of a business's history:

- **The exact count.** Every paged screen in Carl asks PostgREST for `count: 'exact'`, which
  counts the whole filtered set. Under the old policy that meant three permission lookups for
  every sale the business had ever made — two seconds at 20,000 sales, and it grows with the
  shop.
- **A cashier's own list.** `sales.view` without `sales.view_all` means most rows fail the
  filter, so the scan walks the whole table looking for fifty that pass, running the permission
  lookups on each.

Both are now a comparison against a set resolved once for the statement.

### And the other thirty-three policies (2026-09-14)

The same argument applies to every table a shop accumulates rows in, so the remaining
thirty-three read policies were rewritten the same way in
`20260101004400_readable_sets_everywhere.sql`. Measured first, on 20,000 rows per table:

| Query, as Carl's screen sends it | Before   | After   |
| -------------------------------- | -------- | ------- |
| Customer list, first page        | 716 ms   | 11.9 ms |
| Customer list, the exact count   | 711 ms   | 8.4 ms  |
| Expenses, the exact count        | 1,045 ms | 9.2 ms  |
| Audit log, first page            | 1,016 ms | 3.6 ms  |
| Audit log, the exact count       | 1,008 ms | 2.7 ms  |
| Expenses, first page             | 2.7 ms   | 0.8 ms  |

The customer list is worth a second look: its first page was slow too, not only its count.
The screen orders by name, and no index carried that order, so the old policy had to be
evaluated for every row before the sort could begin.

`20260101004500_list_orderings.sql` adds the three indexes that were missing — customers and
products by name, purchases by created_at — measured on 20,000 rows:

| List, first page | Without | With   |
| ---------------- | ------- | ------ |
| Customers        | 11.7 ms | 0.1 ms |
| Purchases        | 13.3 ms | 0.6 ms |
| Products         | 5.6 ms  | 0.1 ms |

Small numbers, and they are small because the sort is the whole cost: it grows with everything
a shop has ever recorded, while an index that already carries the order does not. Every other
paged screen already had its index; suppliers is indexed on `lower(name)` and orders by `name`,
which is recorded in the migration and deliberately left alone at the size a supplier list
reaches.

Four more sets were needed for the rules that are not "one permission over one branch":
`member_tenant_ids()`, `permitted_tenant_ids(p)`, `accessible_branch_ids_all()` and
`permitted_branch_ids(p)`. Each is built by calling the function it replaces, and
`tests/db/readable-sets.test.ts` asserts all six against their originals — sixty-four
combinations of person, business, branch and permission.

Eleven more tables gained the composite foreign key that makes the equivalence exact: a row's
branch has to belong to a row's tenant.

`tests/db/hot-query-plans.test.ts` asserts the property rather than the timings: these queries
must contain no `SubPlan` — no per-row permission lookup — for a manager or a cashier.

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

- **The remaining thirty-three policies** that call `app.can_read` per row (`customers`,
  `expenses`, `purchases`, `transfers`, `audit_logs` and others). The same argument applies to
  every paged screen that asks for an exact count, so the fix is probably the same — but the
  measurement has to come first, on the queries those screens actually send, and it has not
  been taken yet. The probe now seeds those tables and covers their queries, ready for it.
- `LEAKPROOF` helpers, which would let PostgreSQL apply ordinary filters first everywhere.
  Marking a function leakproof requires superuser, which a hosted Supabase project does not
  grant, so this needs Supabase's involvement.
