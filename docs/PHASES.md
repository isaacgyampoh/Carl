# Build phases

Carl is built in verified phases. Each ends with `pnpm verify` passing; a phase does not start
until the previous one is green. Known defects are fixed before moving on rather than recorded
as debt.

| #   | Phase                                                  | Status         |
| --- | ------------------------------------------------------ | -------------- |
| 0   | Foundation — monorepo, tooling, layering, test harness | ✅ Complete    |
| 1   | Database — full schema, constraints, indexes           | ⬜ Not started |
| 2   | Security — auth, roles, permissions, RLS + tests       | ⬜ Not started |
| 3   | Tenants, branches, staff, devices, activation          | ⬜ Not started |
| 4   | Products, pricing, inventory, transfers, stock takes   | ⬜ Not started |
| 5   | POS — cart, payments, sale completion, receipts        | ⬜ Not started |
| 6   | Purchasing, suppliers, expenses, cash register         | ⬜ Not started |
| 7   | Returns and refunds                                    | ⬜ Not started |
| 8   | Reporting and dashboards                               | ⬜ Not started |
| 9   | Platform administration                                | ⬜ Not started |
| 10  | PWA and mobile                                         | ⬜ Not started |
| 11  | Tauri desktop application                              | ⬜ Not started |
| 12  | Offline synchronisation                                | ⬜ Not started |
| 13  | Security hardening                                     | ⬜ Not started |
| 14  | Performance                                            | ⬜ Not started |
| 15  | Production readiness                                   | ⬜ Not started |

---

## Phase 0 — Foundation ✅

**Delivered**

- pnpm workspace monorepo: 8 packages, 1 app, 1 test package
- TypeScript 6 in strict mode, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`
- ESLint 10 with type-aware rules **and machine-enforced architectural boundaries** — a domain
  module that imports React or a database driver fails the build
- Money and quantity as exact integer arithmetic, with tests covering the float-drift and
  remainder-allocation cases that break naive implementations
- `Result` type, structured error vocabulary shared with the database, branded identifiers,
  idempotency primitives, redacting structured logger, cursor pagination
- Permission catalogue (54 permissions) and 8 system role templates as the single source of
  truth for both TypeScript and the forthcoming database seed
- Public/secret environment split enforced at build time by `server-only`
- **A database test harness running real PostgreSQL with real RLS, without Docker**, and a
  suite proving the harness itself is trustworthy
- CI: typecheck, lint, format, unit tests, database tests, build, secret scan

**Verification**

```
typecheck   10 packages    pass
lint        0 problems     pass
tests       45 passed      pass
build       Next.js 16     pass
```

**Environment notes**

Docker and the Rust toolchain are absent from the current development machine. Neither blocks
Phases 0–10: the database suite runs on in-process WebAssembly PostgreSQL by design. Rust is
required before Phase 11 (Tauri), and Docker is required only for `supabase start` and for the
pre-release run against a real Supabase instance in Phase 15.

---

## Phase 1 — Database ✅

**Delivered**

11 migrations: **47 tables, 150 indexes, 102 check constraints, 30 triggers, 27 enum types.**

- Identity and tenancy: profiles, tenants, branches, memberships, branch scoping
- Roles and permissions as editable rows, with cross-tenant reference guards
- Devices, activation codes and per-installation device sessions
- Catalogue: products tenant-wide, multiple barcodes, windowed prices
- Inventory as an append-only ledger plus a maintained running total, transfers, stock counts
- Sales, line items, split payments, returns and refunds
- Suppliers, purchasing, expenses, cash register sessions
- Audit log, idempotency keys, sync conflicts, notifications
- Platform: subscriptions, payments, installations, maintenance, time-boxed support grants
- Permission seed **generated** from `@carl/domain`, with a drift test

**Verification**

```
format      pass     typecheck   pass     lint   pass (0 problems)
tests       84 passed (35 unit, 49 database)      build  pass
```

Database tests cover: migrations apply to a clean database; tenant-scoped uniqueness;
cross-tenant reference rejection; sale arithmetic consistency; Momo reference requirement;
ledger direction and immutability; audit-log immutability; single-default/single-open
invariants; activation-code bounds; support-grant bounds; ledger reconciliation including
fractional quantities and point-in-time reconstruction.

**Notable decisions**

- Extension objects are always schema-qualified. An unqualified `citext` applied cleanly on a
  developer machine and failed on a clean database — caught by the migration test, not review.
- The append-only trigger blocked a test that tried to backdate a ledger row. The test was
  rewritten to insert with a past timestamp; the guarantee was not weakened to accommodate it.
- No RLS yet. Policies and the isolation suite are Phase 2, so the schema can be reviewed
  independently of the access rules layered on it.

**Known issues**

None. Row Level Security is not yet enabled — tables are currently reachable only by the
service role and the migration owner, and Phase 2 closes that before any application code
reads them.
