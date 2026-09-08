# Architecture

## Shape

Carl is a **modular monolith** built on **Clean Architecture**. One deployable application,
with internal boundaries firm enough that a module could later be extracted if scale demanded
it — and not before.

Microservices were rejected deliberately. Carl's most important operation, completing a sale,
touches five tables and must be atomic. Distributing that across services would replace a
database transaction with a distributed one: the hardest problem in the system, adopted
voluntarily, to solve a scaling problem Carl does not have.

## The dependency rule

Dependencies point inward. Nothing in an inner layer knows anything about an outer one.

```
        ┌─────────────────────────────────────────┐
        │  apps/web · apps/desktop · packages/ui  │   Presentation
        └────────────────────┬────────────────────┘
                             ↓
        ┌─────────────────────────────────────────┐
        │           packages/application          │   Use cases, ports
        └────────────────────┬────────────────────┘
                             ↓
        ┌─────────────────────────────────────────┐
        │             packages/domain             │   Business rules
        └─────────────────────────────────────────┘
                             ↑
        ┌────────────────────┴────────────────────┐
        │  packages/infrastructure · supabase/    │   Adapters, PostgreSQL
        └─────────────────────────────────────────┘
```

Infrastructure sits at the bottom of the diagram but _depends inward_ too: it implements
interfaces the application layer declares. The application never imports a Supabase client; it
imports a port and is handed an implementation.

**This is enforced, not documented.** `eslint.config.mjs` fails the build on a domain module
that imports React, Next, a database driver, or an outer Carl package. Verify it yourself by
adding `import { createClient } from '@supabase/supabase-js'` to any file under
`packages/domain` and running `pnpm lint`.

### Why the rule earns its keep

The rule that decides whether a cashier may apply a 40% discount should be readable, testable
and changeable without a database, a browser, or a running server. In `packages/domain` it is
a pure function with a unit test measured in milliseconds. Embedded in a React component — the
default outcome without enforcement — it would be reachable only through a rendered page, and
would be silently duplicated the first time the desktop app needed the same rule.

## PostgreSQL is part of the application

Carl does not treat Supabase as a REST wrapper over tables. The database carries load-bearing
responsibility:

| Concern              | Where it lives                  | Why there                                             |
| -------------------- | ------------------------------- | ----------------------------------------------------- |
| Tenant isolation     | RLS policies                    | The only layer no client can bypass                   |
| Multi-table writes   | `plpgsql` functions             | Real transactions; partial writes are impossible      |
| Invariants           | CHECK / UNIQUE / FK constraints | Enforced even against a direct psql connection        |
| Reporting aggregates | SQL                             | Moving a million rows to compute one number is absurd |

A sale is a single `complete_sale()` call. It validates the caller, re-derives every price
from the catalogue, checks stock, writes the sale, its items, its payments, the inventory
movements and the audit entry — and commits or rolls back as one unit. There is no sequence of
operations that leaves stock decremented without a sale to explain it.

### What the client is for

The client renders and collects input. It is not trusted for anything else. In particular it
never supplies a price, a line total, an order total, a tenant id, a branch id, a role, or a
stock level. It supplies _which product_ and _how many_; the server determines what that costs.

A price arriving from a browser is not validated — it is ignored.

## Package boundaries

| Package          | May depend on                             | Never depends on                          |
| ---------------- | ----------------------------------------- | ----------------------------------------- |
| `shared`         | nothing                                   | anything                                  |
| `domain`         | `shared`                                  | frameworks, drivers, I/O, browser globals |
| `validation`     | `shared`, `domain`, `zod`                 | frameworks, drivers                       |
| `application`    | `shared`, `domain`, `validation`, `types` | frameworks, drivers, browser globals      |
| `infrastructure` | all inner layers, Supabase SDK            | `ui`, `apps/*`                            |
| `database`       | `shared`                                  | frameworks                                |
| `ui`             | `shared`, React                           | `infrastructure/server/*`                 |
| `apps/web`       | everything                                | —                                         |

`packages/shared` is dependency-free and runtime-agnostic on purpose: it is imported by the
Next.js server, the browser bundle, the Tauri desktop frontend and the test harness. It uses
no `Buffer`, no `process`, and no DOM API.

## Design decisions

### Money is an integer count of minor units

`GH₵12.50` is the integer `1250`, never the float `12.5`. A POS adds thousands of amounts a
day and reconciles against physical cash; IEEE-754 cannot represent `0.10`, and the resulting
drift produces a till that is short by a few pesewas with no traceable cause.

Rounding is **half away from zero**, matching both a human cashier's intuition and
PostgreSQL's `round()` on `numeric`, so the database and the application never disagree.
`allocate()` splits an amount so the parts sum exactly to the whole — GH₵10.00 divided three
ways is `[334, 333, 333]`, not three lots of `333`.

See `packages/shared/src/money.ts`.

### Quantity is an integer count of thousandths

Products are sold by weight and length, so quantity cannot be an integer count of units — and
for the same reason as money, it cannot be a float. `1.5 kg` is `1500`. Three decimal places
matches `numeric(14,3)` in PostgreSQL.

### Identifiers are branded

Every id is a UUID, so every id is structurally a `string`, so nothing stops
`getBranch(productId)` from compiling. In a multi-tenant system that class of mistake leaks
one business's data to another. Branded types make it a compile error at no runtime cost.

### Failures are values, not exceptions

Expected failures — insufficient stock, an incomplete payment, a revoked device — are ordinary
business outcomes that every caller must handle, so they are returned as `Result` values the
type system forces you to unwrap. Exceptions are reserved for genuine defects.

Every failure carries a stable code (`INSUFFICIENT_STOCK`, `PAYMENT_INCOMPLETE`) shared by the
database, the server and the client, so a cashier is told what actually went wrong and the
sync engine can decide whether a retry could succeed.

### Every write is idempotent

Networks fail mid-request, and offline sync guarantees replays. The client generates an
idempotency key once per logical operation and reuses it for every retry; the server records
the key with its outcome and returns the original result rather than charging a customer
twice.

## Offline architecture

The desktop POS is not a cached website. It is a local application over a local SQLite
database with its own sync engine (Phases 11–12). The web PWA offers offline _awareness_ and
cached catalogue reads, but browser storage is not used as the authoritative store for a
financial transaction — SQLite on the terminal is.

Full design: [OFFLINE_SYNC.md](OFFLINE_SYNC.md) _(written in Phase 11)_.
