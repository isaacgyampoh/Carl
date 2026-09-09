# Carl Desktop

The offline-capable POS terminal, built with [Tauri 2](https://tauri.app).

## Status

| Piece                                                  | Status                                      |
| ------------------------------------------------------ | ------------------------------------------- |
| Rust host: keychain commands, SQL plugin, capabilities | ✅ Compiles (`cargo check`, macOS arm64)    |
| Local SQLite schema applied as a migration             | ✅ Verified in the running `.app`           |
| `SqliteSyncQueue` implementing the `SyncQueue` port    | ✅ Implemented, 24 tests                    |
| Catalogue store, device store, API client, transport   | ✅ Implemented, 52 desktop tests            |
| Activation, cashier sign-in, till, payment panel       | ✅ Implemented, bundle builds               |
| Startup database preflight                             | ✅ 7 tests, incl. proof it can fail         |
| End-to-end offline sale against real PostgreSQL        | ✅ 11 tests (`tests/integration/`)          |
| **macOS `.app` launches and initialises SQLite**       | ✅ **Verified by running it**               |
| macOS `.dmg`                                           | ✅ Built                                    |
| Code signing / notarisation                            | ⬜ **Not done** — required before shipping  |
| Windows build                                          | ⛔ BLOCKED — needs the CI Windows runner    |
| Receipt printing                                       | ⬜ **Not implemented**                      |
| Cash drawer kick                                       | ⬜ **Not implemented**                      |
| Barcode scanner                                        | ⚠️ Code path tested; **no hardware tested** |
| Automatic updates                                      | ⬜ Deliberately disabled                    |

Everything marked ✅ has been compiled and run. Nothing here has been tested on a real shop
floor, with a real scanner, or on a real thermal printer.

### Verified in the running application

Launched from a deleted application-data directory, `Carl.app` produced:

```
tables created            10  (full schema)
_sqlx_migrations          v1 carl local schema
journal_mode              wal
boot_count                2   ← data written by an earlier run survived a restart
install_id                present  ← reached the activation flow
```

## Two defects this build fixed, and how they hid

**`Module name, '@tauri-apps/plugin-sql' does not resolve to a valid URL`.** The release
`.app` had been built three hours before the frontend existed, and embedded a placeholder
page whose inline module used a bare specifier. `tauri.conf.json` had no
`beforeBuildCommand`, so `tauri build` never built the frontend — it bundled whatever stale
`dist/` was on disk and said nothing. Now `pnpm build` runs as `beforeBuildCommand`, and it
ends in `scripts/verify-desktop-bundle.mjs`, which refuses to ship a bundle containing a
bare specifier, an unbundled `/src/` entry point, a missing SQL plugin, or an embedded
secret.

**The schema had never been applied on any terminal.** `main.rs` carried a comment saying
migrations ran on startup, and `tauri_plugin_sql::Builder::default()` registers none. Only
`sync_queue` existed, created separately by the queue itself, so the next failure after the
module error would have been `no such table: device_config`. The schema is now registered as
migration v1 via `include_str!`.

Both were invisible to the type checker, the tests and the Tauri build. The startup
preflight exists because of them: a terminal that cannot record a sale must refuse to open,
rather than take money it cannot write down.

## Why a desktop application at all

A browser cannot be trusted with a shop's money when the connection drops:

| Concern                    | Browser                                                     | Carl Desktop                              |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| Durable local transactions | IndexedDB — evictable by the browser under storage pressure | SQLite on disk                            |
| Credential storage         | Local storage — a file, readable by anything on the machine | OS keychain                               |
| Receipt printer            | Print dialog only                                           | Direct to a thermal printer (not built)   |
| Cash drawer                | No                                                          | Via the printer's kick port (not built)   |
| Survives a crash mid-sale  | Sometimes                                                   | Yes — the sale is committed locally first |

The deciding factor is the first row. A browser may evict IndexedDB without warning, and
"the browser cleared your unsynced sales" is not a sentence any shop should have to hear.

## Architecture

```
  Carl Desktop
  ├── React SPA (Vite)     activation → cashier sign-in → till
  ├── @carl/domain         cart and pricing — the same code the web app runs
  ├── @carl/sync           the sync engine — the same code the PWA runs
  ├── SqliteSyncQueue      durable implementation of the SyncQueue port
  └── Rust host            keychain, SQL plugin, window
```

A plain SPA rather than the Next.js application: a till has no server beside it, and the
whole point of this build is that it keeps selling when there is nothing to render against.
Business rules are shared through `@carl/domain`, so the two clients cannot disagree about
what a sale costs.

The sync engine is **shared, not reimplemented**. A second implementation of "did this
transaction sync" would be a second thing that can be wrong about money.

## The two credentials

A terminal must prove two separate things, and neither is sufficient alone.

**Which till it is** — the device secret, issued once by `activate_device`. It goes into the
OS credential store, never into SQLite or a config file. A stolen laptop then yields a
product catalogue and some already-printed receipts, not a working credential for the
tenant.

**Who is standing at it** — the cashier's Supabase session. `complete_sale` requires the
acting user to be an active member holding `sales.create` at that branch, so a sale is
attributed to a person. The refresh token lives beside the device secret in the keychain.

Syncing as the service role would satisfy the database while attributing every offline sale
to nobody and skipping every permission check. It is not done, anywhere.

## Why the terminal never talks to PostgreSQL

`activate_device`, `sync_offline_sale` and `device_catalogue` all take the device-secret
pepper as an argument, and the pepper lives in neither the database nor the terminal — it is
what stops a stolen database dump from yielding working credentials for every till in the
estate. So the terminal goes through three HTTP routes on the application server, which hold
the pepper: `/api/device/activate`, `/api/device/catalogue` and `/api/device/sync`.

## What a terminal may download

`device_catalogue` returns products, barcodes, branch-resolved prices, this branch's stock,
and customers' names, phones and price tiers.

It deliberately excludes `average_cost` and `last_cost` (a stolen laptop should not reveal
what the business pays its suppliers), customer balances and credit limits, every other
branch's stock, and every other tenant's anything. Six tests in
`tests/db/device-catalogue.test.ts` assert those absences.

## Windows

Windows is built by `.github/workflows/desktop.yml` on a `windows-latest` runner, which
already carries the MSVC toolchain and the WebView2 runtime Tauri needs. That is the whole
reason it runs there rather than being cross-compiled: a Windows installer produced by a
machine that has never run Windows is not evidence that it works.

The workflow produces `.msi` and NSIS `.exe` bundles and uploads them as the
`carl-windows-x64` artifact, with `if-no-files-found: error` so a job that silently builds
nothing fails rather than reporting green with nothing attached.

**A successful CI build is not the same as a working installer.** Until the artifact has been
downloaded, installed and run on Windows — SQLite initialising, a terminal activating, a
sale completing offline — Windows stays untested, and this table will say so.

## Building

```bash
# Rust toolchain, once
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

pnpm install
pnpm --filter @carl/desktop dev            # Vite only, in a browser
pnpm --filter @carl/desktop dev:desktop    # the real Tauri window
pnpm --filter @carl/desktop bundle         # platform bundle
```

Configuration is baked in at build time and is deliberately not editable from the terminal —
a till that can be pointed at a different server by someone standing in front of it is a
till whose sales can be redirected:

| Variable                 | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `VITE_CARL_URL`          | Where the Carl application server is         |
| `VITE_SUPABASE_URL`      | Supabase project URL, for cashier sign-in    |
| `VITE_SUPABASE_ANON_KEY` | Public anon key — RLS decides what it can do |
| `VITE_APP_VERSION`       | Reported at activation                       |

The service-role key is not here, is not in any client, and must never be.

## Testing

The queue, catalogue store, device store and API client are tested with Node's built-in
SQLite rather than only inside a compiled binary — a queue that can only be tested by
building a desktop app is a queue nobody tests. The catalogue and device stores run against
the actual `src-tauri/schema.sql` the application ships, so the tested schema cannot drift
from the one on the shop floor.

```bash
pnpm vitest run --project unit apps/desktop
pnpm vitest run --project db tests/integration/offline-terminal.test.ts
```
