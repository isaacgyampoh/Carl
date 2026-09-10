# The six real-PostgreSQL failures

Status: **UNRESOLVED — blocked on a database connection.**

This file is the durable record of what has and has not been established. It exists because
the previous run's log was written to `/tmp` and removed by the OS temp sweeper between
sessions, taking the only copy of the error output with it.

## What happened

A full run against real Supabase PostgreSQL produced:

```
Test Files  13 failed | 14 passed (27)
     Tests   6 failed | 244 passed | 163 skipped (413)
  Duration   3907s (65 minutes)
```

All six named failures were in `tests/db/pricing.test.ts > pricing > product search`:

| #   | Test                                        | Asserts                                   |
| --- | ------------------------------------------- | ----------------------------------------- |
| 1   | returns an exact barcode match on its own   | `rows` length 1, `rows[0]` fields         |
| 2   | multiplies a case barcode by its pack size  | `rows[0].pack_size`, `rows[0].unit_price` |
| 3   | finds a product from a partial name         | `rows.map(name)` contains                 |
| 4   | excludes inactive products                  | `rows` length 0                           |
| 5   | never returns another tenant's products     | `rows` length 0                           |
| 6   | reports current stock alongside each result | `rows[0].quantity`                        |

Two tests in the same `describe` did **not** fail: _"tolerates a typo"_ and _"returns nothing
for an empty query"_.

## What has been established, with evidence

- **The deployed function is not stale.** `pg_get_functiondef(search_products)` on production
  is byte-identical to `supabase/migrations/20260101001900_pricing.sql` once
  `pg_get_functiondef`'s own normalisation is accounted for.
- **`pg_trgm` is present and correct on production**, installed in the `extensions` schema,
  and `extensions.similarity` resolves and returns sane values.
- **The same six tests pass against PGlite**, repeatedly.
- **Trigram scoring agrees** between the two engines to float precision.

## Differences found between the harness and production

Measured, not assumed. Neither is claimed to be the cause.

|                                        | Production                      | PGlite harness           |
| -------------------------------------- | ------------------------------- | ------------------------ |
| Version                                | PostgreSQL 17.6 (aarch64-linux) | PostgreSQL 18.3 (wasm32) |
| `datcollate`                           | `en_US.UTF-8`                   | `C`                      |
| `similarity('Coca-Cola 500ml','coca')` | 0.357143                        | 0.35714287               |
| `similarity('Coca Cola','cocacola')`   | 0.7                             | 0.7                      |
| `pg_trgm.similarity_threshold`         | 0.3                             | 0.3                      |

**The collation difference is real and worth correcting regardless of this investigation.**
`search_products` ends with:

```sql
order by c.rank, extensions.similarity(p.name, v_term) desc, p.name
```

`p.name` is the tiebreaker, and `C` and `en_US.UTF-8` order text differently — punctuation
and case in particular. Three of the six failures assert on `rows[0]` specifically. A
harness that sorts differently from production cannot prove an ordering-sensitive assertion
either way.

**The major-version difference is also notable**: the harness runs a _newer_ PostgreSQL than
production, so it can accept syntax and behaviour that 17.6 rejects.

## Hypotheses NOT established

Recorded so nobody mistakes them for findings:

- A pooler connection drop partway through a 65-minute run. The shape of the result — 13
  files failing but only 6 tests failing, with 163 skipped — is consistent with suite-level
  hook failures cascading. It is **not proven**, and the failing set is not a contiguous
  prefix of the file, which a simple mid-run death would produce.
- Collation causing the ordering assertions to differ. Plausible, unproven.
- Anything about test parallelism, resource exhaustion, or session state. Untested.

## What is needed to finish this

A session-mode connection string in `~/.carl/db.env` (port **5432** — transaction mode on
6543 hands each statement to a different backend, which breaks `SET ROLE` and transactions,
and the RLS suite depends on both).

Then, in order:

1. Full suite, output captured to `~/.carl/results/` — outside `/tmp`, which is what was
   lost last time.
2. The six tests in isolation, then sequentially, then in file order, then with the full
   suite's worker configuration.
3. Timing correlation: whether failures cluster at a consistent elapsed time.
4. `pricing.test.ts` alone, versus the same file after a long preceding run.

Until that is done Carl is **NOT RELEASE READY**, regardless of the local suite being green.
