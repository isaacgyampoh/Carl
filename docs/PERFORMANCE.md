# Performance at a shop's second year

Carl is fast on a new shop and stays fast for a long time. This records where it stops being
fast, measured rather than guessed, so the work is done before a client hits it rather than
after.

## How to measure

`scripts/performance-probe.mjs` generates a year of trade — 10,000 products, 100,000 sales,
500,000 line items, 100,000 stock movements — and runs the queries a shop actually waits on,
as an authenticated cashier, so Row Level Security is in every plan.

It writes hundreds of thousands of rows and does not clean up, so it refuses to run without
`CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes` and belongs on **staging**, never production:

```bash
set -a; . ~/.carl/staging.env; set +a
CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes pnpm run db:perf
```

## What it found (2026-09-11, staging, micro instance)

| Query                            | Budget   | Measured                 | Plan                                        |
| -------------------------------- | -------- | ------------------------ | ------------------------------------------- |
| Barcode scan                     | 50 ms    | 4 ms                     | index                                       |
| Low stock                        | 400 ms   | 2 ms                     | index                                       |
| Today's takings                  | 400 ms   | **543 ms**               | sequential scan of 100,000 sales            |
| Sales list, first page           | 200 ms   | **slow**                 | sequential scan of 100,000 sales, then sort |
| Inventory ledger for one product | 300 ms   | **5,981 ms**             | sequential scan of 10,000 products          |
| Best sellers over a year         | 5,000 ms | **cancelled by timeout** | —                                           |

A shop's first year is nowhere near this volume, and everything here is fast today. The
figures matter for a busy branch's second year, and for any client running several branches
through one business.

## Why, and why it is not simply a missing index

The indexes exist: `sales (tenant_id, sold_at desc)`, `products (tenant_id, sku)`,
`inventory_movements (branch_id, product_id, occurred_at desc)`, and more.

The cause is the shape of the security policies. Every policy's predicate is a function of the
row — `app.can_read(sales.tenant_id, 'sales.view_all', sales.branch_id)` — so:

1. PostgreSQL cannot use it to choose an index, because it is not a comparison against a
   constant; and
2. because the helper is not `LEAKPROOF`, the security predicate must be evaluated **before**
   ordinary filters like `sold_at >= now() - interval '1 day'`, so the index on `sold_at`
   cannot narrow the scan first. Every row is examined, and three membership and permission
   lookups run for each one.

Two permissive SELECT policies on `sales` (one for a cashier's own sales, one for everyone
else's) are ORed together, which removes the last chance of an index-driven plan.

## What was tried, and did not work

Adding a cheap, index-friendly tenant predicate in front of the exact check — `tenant_id in
(select app.readable_tenants('sales.view_all')) and (select app.can_read(…))`, with the tenant
set computed once per statement.

Measured on the same data: "Today's takings" improved (543 ms → 295 ms), everything else did
not, and "Sales list, first page" got worse. The planner still chose a sequential scan, because
the ORed pair of policies leaves a disjunction it cannot drive an index from. The change was
reverted rather than shipped: a change to security policies that does not clearly pay for
itself is not worth the risk of subtly altering what a policy allows.

## What would work, in order of preference

1. **One SELECT policy per table instead of two.** Fold "own sales" and "all sales" into a
   single predicate so the planner sees a conjunction it can index. This is a behaviour-neutral
   rewrite that the 610 database tests already cover.
2. **Compare against a value, not a function.** Resolve the caller's readable tenants and
   branches once per request — into a temporary setting or a session table — and make policies
   plain equality against it. This is the shape Supabase's own guidance recommends at scale.
3. **`LEAKPROOF` helpers**, which would let PostgreSQL apply ordinary filters first. Marking a
   function leakproof requires superuser, which a hosted Supabase project does not grant, so
   this needs Supabase's involvement.

None of it is urgent for the first clients. All of it should be done before a branch is taking
hundreds of sales a day, and it should be measured with the probe above rather than assumed.
