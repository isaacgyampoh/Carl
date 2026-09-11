# Offline synchronisation

Carl POS keeps selling when the internet does not. This describes how, and — more
importantly — what happens when the transactions come back and disagree with each other.

> **Status.** The server side, the sync engine, the SQLite queue and the Tauri desktop
> application (Carl POS for Windows) are implemented and tested, and the Windows installer is
> built by CI. Not yet exercised on a physical Windows till; the first client's till is that
> validation. See [Current state](#current-state).

---

## The problem

Two terminals lose connectivity while a branch holds **10 units** of a product.

```
            Terminal A                    Terminal B
            ──────────                    ──────────
09:14       sells 8
09:31                                     sells 7
            ↓                             ↓
        receipt printed               receipt printed
        customer leaves               customer leaves

17:00       connection returns — both queues sync
```

Both cashiers took money. Both customers left with goods. Fifteen units were sold from a
shelf that held ten.

There are three things a POS can do here, and two of them are wrong:

| Approach                           | What happens                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Reject the second sale             | The receipt is printed and the customer has gone. The shop has money it cannot account for and a sale that does not exist.   |
| Accept it silently                 | Stock goes negative or is quietly corrected. The shop finds out at stock-take that its inventory has been wrong for a month. |
| **Record it and raise a conflict** | A human decides: was the count wrong, must stock be sourced, or is a refund owed?                                            |

Carl does the third. **The software does not make a business decision silently.**

---

## What happens on sync

```
  local queue                  sync_offline_sale()              outcome
  ───────────                  ───────────────────              ───────
  PENDING  ──────────────────► complete_sale()  ─── ok ───────► SYNCED
                                     │
                                     ├── INSUFFICIENT_STOCK ──► CONFLICT  → a person
                                     ├── PRODUCT_REMOVED ─────► CONFLICT  → a person
                                     ├── PRICE_NOT_CONFIGURED ► CONFLICT  → a person
                                     │
                                     ├── DEVICE_REVOKED ──────► HALT (whole run)
                                     └── TENANT_SUSPENDED ────► HALT (whole run)
```

`sync_offline_sale` **wraps** `complete_sale` rather than duplicating it. Every rule — price
resolution, payment validation, permission checks, receipt numbering — is the same one an
online sale goes through. A separate offline path would drift, and the drift would only
show up in the transactions nobody watched happen.

### Conflicts versus hard stops

A **conflict** is a business-rule failure: the shop's own data disagrees with what the
terminal did. It is recorded with the payload verbatim, a notification is raised, and it
waits for a person.

A **hard stop** is a revoked terminal or a suspended tenant. It propagates as an error and
stops the run. Recording it as "needs review" would let a stolen terminal keep filing sales
for someone to rubber-stamp.

---

## The engine's contract

**No queued transaction is ever silently discarded.**

Every operation ends in one of four states, and all four are kept:

| State       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `SYNCED`    | Accepted by the server                                               |
| `CONFLICT`  | Declined on business grounds; raised for a human. **Never retried.** |
| `FAILED`    | A transient failure; scheduled for retry                             |
| `ABANDONED` | Failed too many times. **Set aside, not deleted.**                   |

`ABANDONED` is the one that matters. A sale that cannot be synced still happened — the
customer paid and took the goods — so the row survives for someone to deal with. A queue
that deletes what it cannot deliver is a queue that loses money quietly.

### Order is part of correctness

Operations are submitted **oldest first, by when the sale actually happened**. Sales apply
against a running stock balance, so replaying them out of order produces a different
sequence of ledger balances than actually occurred. Submitting concurrently would be faster
and wrong.

### Retries are jittered

Every till in a branch loses the connection together and recovers together. Without jitter
they would all retry at the same instants, fail together, and line up to do it again. The
delay is drawn from `[0, min(2s · 2ⁿ, 5min)]` — full jitter, capped so an overnight outage
does not delay the morning.

### A conflict is never retried

Retrying cannot change a business decision the server declined to make, and retrying
forever turns a queue into a loop.

---

## Idempotency

The client generates a key **once per logical sale**, when the cashier confirms payment —
not per attempt. Generating it inside a retry loop would provide no protection at all.

The server claims the key with an `INSERT` against a unique index _before doing any work_,
so two concurrent retries cannot both proceed. A second arrival returns the original sale
and reports itself as a **replay**, which lets the engine mark the operation done rather
than retrying forever.

A key reused for a _different_ request is refused (`IDEMPOTENCY_KEY_REUSED`) — otherwise a
client could have a cheap sale's response returned in place of an expensive one.

---

## Offline authorisation

A terminal cannot ask permission while offline; that is the entire point. Instead each
device carries `authorized_until`, refreshed on every successful sync. It keeps working
until that moment passes, then stops.

```
  sync ──► authorized_until = now + offline_grace_hours   (default 7 days)
                     │
                     └── passes with no contact ──► DEVICE_AUTHORIZATION_EXPIRED
```

The window is a trade-off with no correct answer:

- **Too short** — a genuine outage closes the shop.
- **Too long** — a stolen terminal keeps trading for weeks.

Seven days is the default and it is a **per-device column**, so a high-risk site can be
tightened without redeploying anything.

Revocation clears `authorized_until` immediately rather than letting the device run out its
window, so a reported-stolen till stops at its next authorisation check.

---

## Device credentials

Activation codes and device secrets are bearer credentials and are treated as such:

- 60 bits of CSPRNG entropy for a code; 256 bits for a secret
- stored **only** as a SHA-256 hash, peppered with a server-side value that never enters
  the database — so a stolen dump cannot brute-force a short code
- codes are single-use (enforced by a unique index), capped at 48 hours by a `CHECK`, and
  revocable
- a wrong code and a non-existent code raise the same error, so guessing reveals nothing

Activation is **idempotent per installation**. Installs happen in shops on unreliable
connections; without this, a dropped response leaves the installer holding a till that is
activated but has no secret and no way to obtain one.

The alphabet excludes `I`, `O`, `0` and `1` — an installer transcribes these by hand.

---

## What the terminal stores locally

Only what is needed to sell:

```
products · barcodes · prices · categories
customers · branch and tax configuration
device configuration · pending transactions · sync metadata
```

Not a replica of the tenant database. Sales history, staff records, purchasing and reports
stay on the server: a stolen terminal should yield a catalogue, not a business.

---

## Current state

| Piece                                                         | Status                                       |
| ------------------------------------------------------------- | -------------------------------------------- |
| `sync_offline_sale`, conflict recording, `device_sync_state`  | ✅ Implemented, 16 database tests            |
| Device activation and offline authorisation window            | ✅ Implemented, 30 database tests            |
| Sync engine (queue state machine, ordering, backoff, halting) | ✅ Implemented, 24 unit tests                |
| `InMemorySyncQueue` reference implementation                  | ✅ The contract the durable queues must meet |
| SQLite queue (Tauri)                                          | ✅ Implemented, tested against `schema.sql`  |
| Tauri desktop application (Carl POS for Windows)              | ✅ Built by CI on a Windows runner           |
| One business per till (re-activation wipes or refuses)        | ✅ `tenant-boundary.ts`, tested              |
| A till sells only at its own branch                           | ✅ Migration 0040, tested                    |
| IndexedDB queue (PWA)                                         | Not built, by decision (see below)           |
| Installed on a physical Windows till                          | ⬜ First client onboarding                   |

### Why the web app has no offline selling

The web till and the installed web app are **online only**. An offline sale must be written
durably before the receipt prints and later proved to belong to a registered terminal. A
browser can clear its own storage and cannot hold a device secret out of reach of the page,
so a web offline queue would be the weaker of two copies of the logic that handles money.
Merchants who need to sell through outages, or who want to sell offline first, use Carl POS
for Windows.

The engine is deliberately storage-agnostic. Carl Desktop will back it with SQLite and the
PWA with IndexedDB, and both run the same code against the same tests — a second
implementation of "did this transaction sync" would be a second thing that can be wrong
about money.

### On testing a genuine race

The two-terminal oversell is tested by syncing two offline sales in sequence, which is what
actually happens: the queues arrive one after another. A genuine _simultaneous_ race
requires two database sessions, and the in-process test harness cannot provide them — see
[TESTING.md](TESTING.md). That case is verified against a real PostgreSQL in Phase 15 and
is marked as such rather than being covered by a test that would pass either way.
