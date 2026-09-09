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

---

## Phase 2 — Security ✅

**Delivered**

**102 RLS policies across 50 tables**, 11 access-helper functions, tenant provisioning, and a
57-test database security suite.

- Access helpers in a non-exposed `app` schema: all `STABLE`, `SECURITY DEFINER`, and pinned
  with `set search_path = ''`
- RLS on every table, `FORCE`d so the owner is not exempt
- Reads and writes separated: a suspended tenant reads its own records but cannot trade
- Every UPDATE policy specifies both `USING` and `WITH CHECK`
- Role-rank ceiling preventing anyone granting a role stronger than their own
- Time-boxed, customer-visible support grants as the only route to tenant data for Carl staff
- `provision_tenant()` — atomic tenant, branch, system roles and owner
- Role templates **generated** from `@carl/domain`, like permissions

**Verification**

```
format  PASS   typecheck  PASS   lint  PASS   test  PASS   build  PASS
141 tests (35 unit, 106 database)
```

**Three bugs found by tests, not by review**

1. **Trigger functions resolved unqualified table names.** They broke inside any
   `SECURITY DEFINER` function — and were a search_path injection route. All now pin
   `search_path` and fully qualify. Surfaced when `provision_tenant()` failed with
   "relation tenant_memberships does not exist".

2. **Integrity triggers read through RLS**, validating against a _filtered_ view of the
   database. A row they needed to compare against could be invisible to the writer, so the
   check passed or failed for the wrong reason. Now `SECURITY DEFINER`.

3. **`profiles.is_platform_admin` could not be protected without infinite recursion.**
   Guarding a privilege column on a self-editable row needs a policy on `profiles` that reads
   `profiles`; PostgreSQL refuses that (42P17), and the same recursion would have broken every
   legitimate profile update. Caught because `expectDenied` refuses to accept a statement that
   failed for the wrong reason. Fixed by moving platform administration to its own table —
   which also removes the escalation surface entirely and makes the grant auditable.

A fourth, smaller finding: an UPDATE against rows no policy admits matches zero rows and
_reports success_, rather than raising 42501 as an INSERT does. Both are safe; they are not the
same, so the harness gained `expectNoRowsAffected` and the distinction is documented.

**Also corrected**

The verification gate was being checked with `grep -c "Done"`, which reported success while
typecheck was failing. Replaced with `scripts/verify.sh`, which checks exit codes and stops at
the first failure.

**Known issues**

None. Transactional functions (`complete_sale`, `process_return`, …) are Phase 4–7; until they
exist, the tables they write have no INSERT policy, which is the intended state.

---

## Phases 3–7 — Devices, catalogue, POS, returns, cash ✅

**Delivered**

- Device activation: CSPRNG codes, peppered SHA-256 storage, single-use, ≤48h, revocable,
  idempotent per installation, plus the offline authorisation window
- A database type generator that needs no Docker — introspects the real migrations applied
  to in-process PostgreSQL (2,600 lines, 51 relations, 30 functions)
- Authenticated web shell: middleware session refresh, permission-filtered navigation,
  sign-in that does not leak which accounts exist
- Server-side reporting, `SECURITY INVOKER` so RLS filters every underlying row
- Transactional inventory: ledger + cached total, weighted-average cost, transfers that
  deduct at dispatch, stock counts posted as movements
- Price resolution with branch overrides, quantity breaks and historical lookup
- `complete_sale` — one transaction across seven tables, every figure server-derived
- Returns, refunds and voids as distinct events, with composing partial returns
- Cash sessions, movements, expense recording and approval
- Offline sync: `sync_offline_sale`, conflict recording, `device_sync_state`
- `@carl/sync` — a storage-agnostic queue engine with 24 unit tests
- The POS screen itself

**Verification**

```
format  PASS   typecheck  PASS   lint  PASS   test  PASS   build  PASS
394 tests (81 unit, 313 database/integration)
```

**Two results worth singling out**

The cart computes a total in the browser so the cashier sees a figure the instant an item
is scanned; PostgreSQL computes it again because that is what the customer is charged.
Duplicated arithmetic drifts, so the agreement is a test: twelve scenarios chosen where
naive implementations diverge, plus a hundred seeded random baskets, compared to the
pesewa. It was verified to fail when the rounding rule was deliberately broken.

The two-terminal oversell — both tills selling from the same ten units while offline — is
covered end to end: the first sale is accepted, the second becomes a reviewable conflict
with the payload kept verbatim, and stock is never driven negative.

**Known issues**

None outstanding. Three environment constraints remain, all documented rather than worked
around:

- **A genuine simultaneous race is not testable in-process.** PGlite is a single-connection
  engine. The two-terminal lock contention case is marked as requiring a real PostgreSQL
  (Phase 15) rather than covered by a test that would pass either way.
- **Rust is absent**, so the Tauri desktop application and its SQLite queue are not built.
  The sync engine is complete and tested against an in-memory reference queue that defines
  the contract the durable ones must meet.
- **Docker is absent**, so `supabase start` is unavailable. Everything runs against
  in-process PostgreSQL instead.
