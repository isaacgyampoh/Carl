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
| Migrations applied             | ✅ PASS       | 26/26 applied; 50 tables, 199 indexes, 59 functions                            |
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
| Barcode scanner (keyboard emulation)        | ⬜ NOT TESTED | No scanner available; the field accepts keyboard input and an exact match short-circuits |
| Thermal receipt printing                    | ⛔ BLOCKED    | No printer available. Browser print dialog only; direct printing needs the desktop app   |

## Offline

| Item                                         | Status     | Evidence                                              |
| -------------------------------------------- | ---------- | ----------------------------------------------------- |
| Conflict handling on sync                    | ✅ PASS    | Two-terminal oversell raises a reviewable conflict    |
| Idempotent replay                            | ✅ PASS    | Same key returns the original sale                    |
| Sync engine state machine                    | ✅ PASS    | 24 unit tests                                         |
| Offline authorisation window                 | ✅ PASS    | Expiry, revocation and suspension all stop a terminal |
| Local SQLite queue                           | ⛔ BLOCKED | Requires the Rust toolchain                           |
| **End-to-end offline sale on a real device** | ⛔ BLOCKED | Requires the desktop application                      |
| PWA offline awareness                        | ✅ PASS    | `/offline` and `/sw.js` serve without authentication  |

## Desktop

| Item           | Status        | Evidence                                                                 |
| -------------- | ------------- | ------------------------------------------------------------------------ |
| Tauri compiles | ⛔ BLOCKED    | Rust toolchain not installed                                             |
| Windows build  | ⛔ BLOCKED    | Requires Rust; cross-compiling to Windows also needs a Windows toolchain |
| macOS build    | ⛔ BLOCKED    | Requires Rust                                                            |
| Code signing   | ⬜ NOT TESTED |                                                                          |
| SQLite schema  | ⬜ NOT TESTED | Written and reviewed; never executed                                     |

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
5. **Install Rust and build the desktop application** if offline selling is required at
   launch. The web build cannot take a sale offline and says so.
