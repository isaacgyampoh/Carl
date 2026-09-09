# Carl Desktop

The offline-capable POS terminal, built with [Tauri 2](https://tauri.app).

> **Not yet buildable in this repository.** Tauri requires the Rust toolchain, which is not
> installed on the current development machine. What is here is the scaffold, the Rust
> commands, and the SQLite schema — reviewable, but not compiled. See
> [Building](#building) for what to install.

## Why a desktop application at all

A browser cannot be trusted with a shop's money when the connection drops. Specifically:

| Concern                    | Browser                                                     | Carl Desktop                              |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| Durable local transactions | IndexedDB — evictable by the browser under storage pressure | SQLite on disk                            |
| Receipt printer            | Print dialog only                                           | Direct to a thermal printer               |
| Cash drawer                | No                                                          | Via the printer's kick port               |
| Barcode scanner            | Works (keyboard emulation)                                  | Works                                     |
| Survives a crash mid-sale  | Sometimes                                                   | Yes — the sale is committed locally first |

The deciding factor is the first row. A browser may evict IndexedDB without warning, and
"the browser cleared your unsynced sales" is not a sentence any shop should have to hear.

## Architecture

```
  Carl Desktop
  ├── Web layer          the same Next.js POS screen, loaded from the bundle
  ├── Sync engine        @carl/sync — identical code to the PWA
  ├── SQLite queue       durable implementation of the SyncQueue port
  └── Rust commands      activation, device secret storage, printing, drawer
```

The sync engine is **shared, not reimplemented**. `@carl/sync` is storage-agnostic; this
application supplies a SQLite-backed `SyncQueue` and the PWA supplies an IndexedDB one.
A second implementation of "did this transaction sync" would be a second thing that can be
wrong about money.

## Where the device secret lives

Not in SQLite, and not in a config file. It goes into the operating system's credential
store — Keychain on macOS, Credential Manager on Windows — through
`tauri-plugin-stores`/`keyring`. A stolen laptop then yields a catalogue and a queue of
already-printed receipts, not a working credential for the tenant.

The secret is written once at activation and read only by the sync engine.

## Building

```bash
# Install the Rust toolchain first
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

pnpm install
pnpm --filter @carl/desktop tauri dev      # development
pnpm --filter @carl/desktop tauri build    # Windows / macOS bundles
```

## What is implemented

| Piece                                               | Status                       |
| --------------------------------------------------- | ---------------------------- |
| SQLite schema for the offline queue and catalogue   | ✅ Written, reviewed         |
| Rust commands for activation and secret storage     | ✅ Written, **not compiled** |
| `SqliteSyncQueue` implementing the `SyncQueue` port | ⬜ Blocked on the toolchain  |
| Receipt printing and cash drawer                    | ⬜ Blocked on the toolchain  |
| Automatic updates                                   | ⬜ Blocked on the toolchain  |

Nothing here has been compiled or run. It is presented as a reviewable design rather than a
working application, and is marked as such rather than being claimed as complete.
