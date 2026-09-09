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

| Item                                        | Status           | Evidence                                                                                                               |
| ------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Sale completion atomic across 7 tables      | ✅ PASS          | Database tests                                                                                                         |
| Client cannot supply a price                | ✅ PASS          | Test submits 1-pesewa prices; server charges catalogue price                                                           |
| Split payments                              | ✅ PASS          | Cash + Momo + bank in one sale                                                                                         |
| Change only against cash                    | ✅ PASS          |                                                                                                                        |
| Returns, partial returns, voids             | ✅ PASS          | 22 tests                                                                                                               |
| Receipt numbering unique per branch per day | ✅ PASS          |                                                                                                                        |
| Barcode scanner (keyboard emulation)        | ⚠️ PARTIAL       | Code path tested, including the trailing character a scanner appends. **No hardware scanner has ever been connected.** |
| Thermal receipt printing                    | ⬜ **NOT BUILT** | No printer available and no printing code written, on web or desktop                                                   |

## Offline

| Item                                        | Status        | Evidence                                              |
| ------------------------------------------- | ------------- | ----------------------------------------------------- |
| Conflict handling on sync                   | ✅ PASS       | Two-terminal oversell raises a reviewable conflict    |
| Idempotent replay                           | ✅ PASS       | Same key returns the original sale                    |
| Sync engine state machine                   | ✅ PASS       | 24 unit tests                                         |
| Offline authorisation window                | ✅ PASS       | Expiry, revocation and suspension all stop a terminal |
| Local SQLite queue                          | ✅ PASS       | `SqliteSyncQueue`, 24 tests against real SQLite       |
| Queue survives the process being killed     | ✅ PASS       | Written, killed, reopened; the shift is still there   |
| Durable queue matches the reference         | ✅ PASS       | Both driven through the same engine; states identical |
| **End-to-end offline sale**                 | ✅ PASS       | 9 tests: real SQLite queue → real PostgreSQL          |
| Offline sale priced by the server           | ✅ PASS       | Terminal claiming 1 pesewa is charged GH₵160.00       |
| Resend after a lost response                | ✅ PASS       | Sale recorded once; stock sold once                   |
| Revoked terminal keeps its queued sales     | ✅ PASS       | Nothing accepted, nothing destroyed                   |
| Catalogue pull fails without losing the old | ✅ PASS       | Cursor not advanced; previous catalogue intact        |
| **On real hardware, in a real shop**        | ⬜ NOT TESTED | Never run outside this machine                        |
| PWA offline awareness                       | ✅ PASS       | `/offline` and `/sw.js` serve without authentication  |

## Desktop

| Item                                          | Status           | Evidence                                                                        |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| Rust host compiles                            | ✅ PASS          | `cargo check` clean                                                             |
| Frontend bundle builds                        | ✅ PASS          | Vite; verified by `scripts/verify-desktop-bundle.mjs` on every build            |
| **Frontend is actually bundled into the app** | ✅ PASS          | `beforeBuildCommand` added; the shipped `.app` had been built without one       |
| macOS `.app` builds                           | ✅ PASS          | arm64                                                                           |
| macOS `.dmg` builds                           | ✅ PASS          | 4.1 MB                                                                          |
| **macOS application launches and runs**       | ✅ PASS          | Launched; 10 tables created, `journal_mode=wal`, reached the activation flow    |
| **SQLite initialises in the real app**        | ✅ PASS          | `_sqlx_migrations` records `v1 carl local schema`                               |
| **SQLite persists across restarts**           | ✅ PASS          | `boot_count=2` — a value written by an earlier run survived                     |
| Startup preflight refuses a broken database   | ✅ PASS          | 7 tests, including proof the check itself can fail                              |
| Windows build                                 | ⛔ **BLOCKED**   | Workflow written (`.github/workflows/desktop.yml`); needs a push to run CI      |
| Windows runtime                               | ⬜ NOT TESTED    | No artifact exists yet                                                          |
| Code signing and notarisation                 | ⬜ NOT TESTED    | **Required before distributing to any shop**                                    |
| Local SQLite schema                           | ✅ PASS          | Applied as migration v1; tests run against the shipped file itself              |
| Device secret in the OS keychain              | ✅ PASS          | Never written to SQLite or a config file                                        |
| Cashier session in the OS keychain            | ✅ PASS          | Refresh token stored beside the device secret                                   |
| Tauri capabilities are minimal                | ✅ PASS          | SQL load/execute/select/close + dialog save. No filesystem, no shell            |
| CSP confines the WebView                      | ✅ PASS          | `connect-src` limited to the Carl and Supabase origins                          |
| No secret in the desktop bundle               | ✅ PASS          | Build fails on a service-role key, database URL or pepper                       |
| Tauri code cannot leak into the web app       | ✅ PASS          | ESLint forbids `@tauri-apps/*` outside `apps/desktop`; verified by planting one |
| Auto-update                                   | ⬜ NOT TESTED    | Deliberately disabled                                                           |
| Receipt printing                              | ⬜ **NOT BUILT** | No printer code exists                                                          |
| Cash drawer                                   | ⬜ **NOT BUILT** | No drawer code exists                                                           |

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
6. **Produce and test a Windows build.** `.github/workflows/desktop.yml` builds both macOS
   and Windows on real runners and uploads the installers, but it has never run — pushing
   the branch is what triggers it. Nothing is signed either, and an unsigned build is not
   something to hand a shop.
7. **Test on real hardware.** No barcode scanner and no receipt printer has ever been
   connected to this system. Receipt printing and the cash drawer are not written at all.
