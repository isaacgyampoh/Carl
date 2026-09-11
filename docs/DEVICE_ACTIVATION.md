# Device activation

How a POS terminal becomes a trusted part of a business, and how it stops being one.

## Why a terminal has an identity at all

A cashier's login says _who is selling_. It does not say which physical till the money went
into, which drawer to reconcile at close, or what to do when a laptop running Carl is
stolen — revoking the employee's account leaves the machine's cached credentials working.

So a terminal authenticates separately, and a sale carries both identities.

## The installation flow

```
  Business owner/admin               Installer                    Server
  (portal → Windows POS)             ─────────                    ──────
  ────────────────────
  add till (register_device) ───────────────────────────────────► status PENDING
  issue activation code ────────────────────────────────────────► hash stored
        │
        └── code shown once ──────►  types it into a fresh till
                                            │
                                            └── activate_device ─► status ACTIVE
                                                                   secret issued
                                            ◄──────────────────────
                                     secret → OS credential store
                                     catalogue downloaded
                                            │
                                            └────────────────────► ready to sell
```

## Activation codes

A code is a bearer credential during its short life, so it is treated as one.

| Property  | Value                                  | Why                                               |
| --------- | -------------------------------------- | ------------------------------------------------- |
| Entropy   | 60 bits (12 chars, 32-symbol alphabet) | Unguessable inside a 24-hour window               |
| Storage   | SHA-256, peppered                      | A database dump yields no working codes           |
| Lifetime  | ≤ 48 hours, enforced by `CHECK`        | A window measured in days is not short-lived      |
| Uses      | One, enforced by a unique index        | Not by application logic, which would race        |
| Revocable | Yes                                    | Issuing a new one invalidates the outstanding one |
| Attempts  | Counted                                | A code being guessed is visible, not silent       |

**The alphabet excludes `I`, `O`, `0` and `1`.** An installer transcribes this by hand, in a
shop, usually onto a phone screen. Those four are misread constantly.

**The pepper never enters the database.** It lives in `CARL_DEVICE_SECRET_PEPPER`, read
server-side. A stolen database dump therefore cannot brute-force a 12-character code.

**A wrong code and a non-existent code raise the same error.** Distinguishing them would
confirm which codes are real.

## Activation is idempotent

Installations happen in shops, on unreliable connections, usually with someone waiting.
If the response to `activate_device` is lost, the installer retries.

Without protection the second attempt reports "code already consumed" and the installer is
left holding a till that is activated but has no secret and no way to obtain one — a state
only a Carl engineer can repair.

So retrying with the **same `install_id`** returns a working session instead. A _different_
installation presenting the same code is still refused: single-use means one till.

## The device secret

256 bits from a CSPRNG, returned once at activation and stored only as a peppered SHA-256
hash on the server.

On the terminal it goes into the **operating system credential store** — Keychain on macOS,
Credential Manager on Windows — never into SQLite or a config file. A thief who copies the
application directory gets a product catalogue and already-printed receipts, not a working
credential for the tenant.

## Offline authorisation

A terminal cannot ask permission while offline; that is the point of offline mode. Instead
each device carries `authorized_until`, refreshed on every successful sync.

```
  successful sync ──► authorized_until = now + offline_grace_hours   (default 7 days)
                             │
                             └── passes with no contact ──► DEVICE_AUTHORIZATION_EXPIRED
```

The window is a trade-off with no correct answer:

- **Too short** — a genuine outage closes the shop.
- **Too long** — a stolen terminal keeps trading for weeks.

Seven days is the default, and it is a **per-device column**: a high-risk site can be
tightened without redeploying anything.

## Revocation

```sql
select revoke_device('<device-id>', 'Reported stolen');
```

Revoking does four things in one transaction:

1. Sets the status to `REVOKED`
2. **Clears the secret hash**, so the credential no longer matches anything
3. **Sets `authorized_until` to now**, so the till stops at its next check rather than
   running out its offline window
4. Closes every session and cancels any outstanding activation code

A reason is required. "Why is this till dead" has to be answerable later.

Revocation is a **hard stop during sync**, not a conflict. Queued sales from a revoked
terminal are refused outright — recording them as "needs review" would let a stolen till
keep filing sales for someone to rubber-stamp.

## What is audited

| Action                          | Recorded                                                   |
| ------------------------------- | ---------------------------------------------------------- |
| `DEVICE_ACTIVATION_CODE_ISSUED` | Who issued it, when it expires, **last 4 characters only** |
| `DEVICE_ACTIVATED`              | The installation id and platform                           |
| `DEVICE_REVOKED`                | Who revoked it and why                                     |

A test asserts that **no activation code or device secret ever reaches the audit log**,
while the last four characters do — enough for support to identify which code is being
discussed without ever handling a working one.

## The `devices_safe` view

Application code reads `devices_safe`, never `devices`. The view omits `secret_hash`
entirely, so a careless `select *` cannot put a credential hash into a log, an API response
or a React prop.

It also derives a `health` column (`ONLINE`, `OFFLINE`, `EXPIRED`, `INACTIVE`, `REVOKED`) so
the "terminals needing attention" view does not reimplement that rule in three places.

## Testing

30 database tests cover this, including: the code alphabet, that only a hash is stored, that
codes are unique across issues, that a superseded code stops working, expiry, single-use,
idempotent retry, wrong pepper, revoked device, suspended tenant, the offline window, and
that nothing secret reaches the audit log.

```bash
pnpm test:db tests/db/device-activation.test.ts
```
