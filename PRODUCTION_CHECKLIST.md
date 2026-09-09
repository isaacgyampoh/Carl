# Carl — production readiness checklist

Every item is marked with what was **actually done**, not what is intended.

| Status            | Meaning                                     |
| ----------------- | ------------------------------------------- |
| ✅ **PASS**       | Executed and verified                       |
| ❌ **FAIL**       | Executed and failed                         |
| ⛔ **BLOCKED**    | Could not be executed; the reason is stated |
| ⬜ **NOT TESTED** | Not attempted                               |

Nothing is marked PASS on the basis of a build succeeding or a type checking. Only on
having been run.

---

## Supabase project

| Item                           | Status        | Evidence                                                                       |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| Project provisioned            | ✅ PASS       | `nkbqqxahvytvutjrsqom`, eu-west-2, PostgreSQL 17.6                             |
| Migrations applied             | ✅ PASS       | 27/27 applied; `device_catalogue` added and verified on the deployed project   |
| Migration history recorded     | ✅ PASS       | `supabase_migrations.schema_migrations`, so `supabase db push` works from here |
| Deployed schema matches source | ✅ PASS       | Counts verified against the migration source                                   |
| Seed data loaded to production | ⬜ NOT TESTED | Deliberate — the seed refuses to run where tenants exist                       |

## Database security

| Item                                          | Status  | Evidence                                                                   |
| --------------------------------------------- | ------- | -------------------------------------------------------------------------- |
| RLS enabled on every table                    | ✅ PASS | 0 tables without it, verified on the deployed database                     |
| RLS **forced** on every table                 | ✅ PASS | 0 tables with RLS enabled but not forced                                   |
| Policies present                              | ✅ PASS | 102 policies deployed                                                      |
| No floating `search_path` on SECURITY DEFINER | ✅ PASS | 0 found, queried from `pg_proc` on the deployed database                   |
| `anon` holds no table privileges              | ✅ PASS | **Was 364 grants. Found on the real project and revoked** (migration 0025) |
| Constraints deployed                          | ✅ PASS | 153 check constraints                                                      |
| Triggers deployed                             | ✅ PASS | 35 triggers                                                                |

## Authentication

| Item                                              | Status        | Evidence                                                                   |
| ------------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| Sign-ups disabled                                 | ⬜ NOT TESTED | Set in `config.toml`; **must be confirmed in the dashboard before launch** |
| Session and inactivity timeouts                   | ⬜ NOT TESTED | Set in `config.toml`; not verified against the deployed project            |
| Redirect URLs restricted to the production origin | ⬜ NOT TESTED | Required before launch                                                     |
| First platform administrator created              | ⬜ NOT TESTED | `insert into platform_admins` — see DEPLOYMENT.md                          |

## Environment and secrets

| Item                                                  | Status        | Evidence                                               |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------ |
| No secret committed                                   | ✅ PASS       | Only `.env.example` is tracked; gitleaks runs in CI    |
| Service-role key server-only                          | ✅ PASS       | Reachable only through modules importing `server-only` |
| `CARL_DEVICE_SECRET_PEPPER` generated per environment | ⬜ NOT TESTED | **Must be set before any device is activated**         |
| Vercel environment variables set                      | ⬜ NOT TESTED | Not deployed                                           |
| **Database password rotated after this exercise**     | ⬜ NOT TESTED | **Required — it was shared in a chat transcript**      |

## Application

| Item                                                  | Status        | Evidence                                     |
| ----------------------------------------------------- | ------------- | -------------------------------------------- |
| Typecheck                                             | ✅ PASS       | All packages                                 |
| Lint                                                  | ✅ PASS       | 0 problems                                   |
| Format                                                | ✅ PASS       |                                              |
| Production build                                      | ✅ PASS       | 33 routes                                    |
| Every authenticated route redirects anonymous callers | ✅ PASS       | Verified by request against a running server |
| Security headers applied                              | ✅ PASS       | Verified by response headers                 |
| Deployed to Vercel                                    | ⬜ NOT TESTED |                                              |
| Custom domain                                         | ⬜ NOT TESTED |                                              |

## Point of sale

| Item                                        | Status        | Evidence                                                                                 |
| ------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| Sale completion atomic across 7 tables      | ✅ PASS       | Database tests                                                                           |
| Client cannot supply a price                | ✅ PASS       | Test submits 1-pesewa prices; server charges catalogue price                             |
| Split payments                              | ✅ PASS       | Cash + Momo + bank in one sale                                                           |
| Change only against cash                    | ✅ PASS       |                                                                                          |
| Returns, partial returns, voids             | ✅ PASS       | 22 tests                                                                                 |
| Receipt numbering unique per branch per day | ✅ PASS       |                                                                                          |
| Barcode scanner (keyboard emulation)        | ⚠️ PARTIAL    | Code path tested, including the trailing character a scanner appends. **No hardware scanner has ever been connected.** |
| Thermal receipt printing                    | ⬜ **NOT BUILT** | No printer available and no printing code written, on web or desktop                  |

## Offline

| Item                                         | Status     | Evidence                                              |
| -------------------------------------------- | ---------- | ----------------------------------------------------- |
| Conflict handling on sync                    | ✅ PASS    | Two-terminal oversell raises a reviewable conflict    |
| Idempotent replay                            | ✅ PASS    | Same key returns the original sale                    |
| Sync engine state machine                    | ✅ PASS    | 24 unit tests                                         |
| Offline authorisation window                 | ✅ PASS    | Expiry, revocation and suspension all stop a terminal |
| Local SQLite queue                           | ✅ PASS    | `SqliteSyncQueue`, 24 tests against real SQLite       |
| Queue survives the process being killed      | ✅ PASS    | Written, killed, reopened; the shift is still there   |
| Durable queue matches the reference          | ✅ PASS    | Both driven through the same engine; states identical |
| **End-to-end offline sale**                  | ✅ PASS    | 9 tests: real SQLite queue → real PostgreSQL          |
| Offline sale priced by the server            | ✅ PASS    | Terminal claiming 1 pesewa is charged GH₵160.00       |
| Resend after a lost response                 | ✅ PASS    | Sale recorded once; stock sold once                   |
| Revoked terminal keeps its queued sales      | ✅ PASS    | Nothing accepted, nothing destroyed                   |
| Catalogue pull fails without losing the old  | ✅ PASS    | Cursor not advanced; previous catalogue intact        |
| **On real hardware, in a real shop**         | ⬜ NOT TESTED | Never run outside this machine                     |
| PWA offline awareness                        | ✅ PASS    | `/offline` and `/sw.js` serve without authentication  |

## Desktop

| Item                                  | Status        | Evidence                                                                 |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| Rust host compiles                    | ✅ PASS       | `cargo check` clean                                                      |
| Frontend bundle builds                | ✅ PASS       | Vite, 229 kB / 72 kB gzipped                                             |
| macOS build                           | ✅ PASS       | arm64                                                                    |
| Windows build                         | ⬜ NOT TESTED | Cross-compiling needs a Windows toolchain                                |
| Linux build                           | ⬜ NOT TESTED |                                                                          |
| Code signing and notarisation         | ⬜ NOT TESTED | **Required before distributing to any shop**                             |
| Local SQLite schema                   | ✅ PASS       | Applied and exercised; tests run against the shipped file itself         |
| Device secret in the OS keychain      | ✅ PASS       | Rust commands compile; never written to SQLite or a config file          |
| Cashier session in the OS keychain    | ✅ PASS       | Refresh token stored beside the device secret                            |
| Activation flow                       | ✅ PASS       | Real `activate_device`, idempotent on retry                              |
| Cashier sign-in                       | ✅ PASS       | A sale is attributed to a person, not to a terminal                      |
| Auto-update                           | ⬜ NOT TESTED | Deliberately disabled                                                    |
| Receipt printing                      | ⬜ **NOT BUILT** | No printer code exists                                                |
| Cash drawer                           | ⬜ **NOT BUILT** | No drawer code exists                                                 |

## Data retention and erasure

Two open questions, both pinned by tests in `tests/db/erasure.test.ts` so they are known in
advance rather than discovered during a request. Neither is a bug to fix quietly: both are
retention decisions for whoever answers to the regulator.

| Item                                                | Status        | Evidence                                                                    |
| --------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| Deleting a person is not blocked by the ledger      | ✅ PASS       | Migration 0026 removed the foreign key; the trigger was not weakened        |
| Stock history survives the person being deleted     | ✅ PASS       | The goods still moved                                                       |
| **Deleting a person who has made a sale**           | ❌ **FAIL**   | `sales.cashier_id` is ON DELETE RESTRICT. Inconsistent with the ledger fix  |
| **Deleting a business**                             | ❌ **FAIL**   | `audit_logs` cascades from `tenants` but is append-only, so it is refused   |
| Closing a business (soft closure)                   | ✅ PASS       | `status = CANCELLED` stops it transacting; `cancelled_at` is required       |

The second is a contradiction in the schema: the foreign key says the audit rows should be
deleted with the tenant, and the trigger says they may never be deleted at all. Every tenant
has audit entries from the moment it is provisioned, so no tenant can ever be hard-deleted.

## Performance

| Item                                       | Status        | Evidence                                                                             |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------ |
| Write throughput at volume                 | ✅ PASS       | 500,000 line items in 39.0s through the real schema, constraints and triggers        |
| 100,000 sales generated                    | ✅ PASS       | 7.3s                                                                                 |
| **Query plans under load**                 | ⛔ **BLOCKED** | The probe filled the project's disk before the read measurements ran. See below      |
| Index usage verified against volume        | ⛔ BLOCKED    | Same                                                                                 |
| Report timings at a year of data           | ⛔ BLOCKED    | Same                                                                                 |

**What happened.** `pnpm db:perf` wrote 610,000 rows and took the database to 398 MB, past
what the free tier allows. PostgreSQL went read-only, then stopped accepting connections
entirely. Recovery needed `TRUNCATE` rather than `DELETE`, because a DELETE writes a WAL
record per row and there was no room left to write one. The project is back: 15 MB,
read-write, schema intact, writes verified.

**Before running it again**, either point `SUPABASE_DB_URL` at a project with real disk, or
reduce the volume — the probe honours `CARL_PERF_PRODUCTS`, `CARL_PERF_SALES` and
`CARL_PERF_LINES`. At the default size it needs roughly 400 MB.

## Operations

| Item                    | Status        | Evidence                                       |
| ----------------------- | ------------- | ---------------------------------------------- |
| Backups enabled         | ⬜ NOT TESTED | Supabase daily backups; PITR needs a paid plan |
| **Restore tested**      | ⬜ NOT TESTED | An untested backup is a hypothesis             |
| Error tracking (Sentry) | ⬜ NOT TESTED | Integration points exist; no DSN configured    |
| Monitoring and alerts   | ⬜ NOT TESTED | Signals documented in DEPLOYMENT.md            |
| Connection pooling      | ✅ PASS       | Session-mode pooler used and verified          |

---

## Blocking items before launch

1. **Rotate the database password.** It was shared in a chat transcript.
2. **Set `CARL_DEVICE_SECRET_PEPPER`** before activating any terminal. Every device secret
   and activation-code hash derives from it; changing it later invalidates all of them.
3. **Confirm sign-ups are disabled** in the Supabase dashboard.
4. **Test a restore.** Not a backup — a restore.
5. **Decide the retention policy for erasure requests.** Today a business can never be
   hard-deleted, and neither can anyone who has rung up a sale. Both are pinned by tests.
6. **Build and sign the desktop application for the platforms it will run on.** It compiles
   and runs on macOS arm64. Windows and Linux have never been built, and nothing is signed —
   an unsigned build is not something to hand a shop.
7. **Test on real hardware.** No barcode scanner and no receipt printer has ever been
   connected to this system. Receipt printing and the cash drawer are not written at all.
