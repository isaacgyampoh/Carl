# Carl Desktop

The offline-capable POS terminal, built with [Tauri 2](https://tauri.app).

## Status

| Piece                                                    | Status                                     |
| -------------------------------------------------------- | ------------------------------------------ |
| Rust host: keychain commands, SQL plugin, capabilities   | ✅ Compiles (`cargo check`, macOS arm64)   |
| Local SQLite schema (queue, catalogue, settings)         | ✅ Applied and exercised by tests          |
| `SqliteSyncQueue` implementing the `SyncQueue` port      | ✅ Implemented, 24 tests                   |
| Catalogue store, device store, API client, transport     | ✅ Implemented, 38 tests                   |
| Activation, cashier sign-in, till, payment panel         | ✅ Implemented, bundle builds              |
| End-to-end offline sale against real PostgreSQL          | ✅ 9 tests (`tests/integration/`)          |
| Receipt printing                                         | ⬜ **Not implemented**                     |
| Cash drawer kick                                         | ⬜ **Not implemented**                     |
| Barcode scanner                                          | ⚠️ Code path tested; **no hardware tested** |
| Automatic updates                                        | ⬜ Deliberately disabled                   |
| Windows / Linux builds                                   | ⬜ **Not built or tested**                 |

Everything marked ✅ has been compiled and run. Nothing here has been tested on a real shop
floor, with a real scanner, or on a real thermal printer.

## Why a desktop application at all

A browser cannot be trusted with a shop's money when the connection drops:

| Concern                    | Browser                                                      | Carl Desktop                              |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| Durable local transactions | IndexedDB — evictable by the browser under storage pressure  | SQLite on disk                            |
| Credential storage         | Local storage — a file, readable by anything on the machine  | OS keychain                               |
| Receipt printer            | Print dialog only                                            | Direct to a thermal printer (not built)   |
| Cash drawer                | No                                                           | Via the printer's kick port (not built)   |
| Survives a crash mid-sale  | Sometimes                                                    | Yes — the sale is committed locally first |

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

| Variable                 | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `VITE_CARL_URL`          | Where the Carl application server is        |
| `VITE_SUPABASE_URL`      | Supabase project URL, for cashier sign-in   |
| `VITE_SUPABASE_ANON_KEY` | Public anon key — RLS decides what it can do |
| `VITE_APP_VERSION`       | Reported at activation                      |

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
