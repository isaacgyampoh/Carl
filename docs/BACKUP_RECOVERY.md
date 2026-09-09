# Backup and recovery

> **Status: documented, not tested.** No restore has been performed. An untested backup is
> a hypothesis, and this document says so rather than implying otherwise.

## What has to survive

Carl holds a shop's financial records. Losing them is not an inconvenience — a business
cannot file tax returns, settle with suppliers, or answer a customer disputing a refund.

Four things matter, in this order:

1. **The sales ledger** — `sales`, `sale_items`, `sale_payments`, `sale_returns`
2. **The inventory ledger** — `inventory_movements`, which explains every stock figure
3. **The audit log** — who did what, and when
4. **Configuration** — tenants, branches, staff, roles, products, prices

The first three are append-only by design, which matters here: a restore to any point in
time yields a _self-consistent_ history rather than a partially-rewritten one.

## Database backups

| Layer                  | Mechanism                  | Retention          | Status             |
| ---------------------- | -------------------------- | ------------------ | ------------------ |
| Automated daily        | Supabase managed backups   | 7 days (Pro)       | ⬜ NOT CONFIGURED  |
| Point-in-time recovery | Supabase PITR (paid plan)  | 7–28 days          | ⬜ NOT CONFIGURED  |
| Pre-migration snapshot | Manual, before each deploy | Until the next one | ⬜ NOT ESTABLISHED |

PITR is the one that matters. Daily backups mean a shop can lose a day of trading — which
for a busy branch is hundreds of transactions and real money that has already changed
hands.

## Recovery scenarios

### A migration went wrong

Migrations are forward-only in production. Reversing one means writing a new migration that
undoes it; running a hand-written `down` against live data is how a mistake becomes data
loss.

```
  1. Stop writes           pause the Vercel deployment
  2. Assess                is the damage structural, or only to data?
  3. Structural  ──────►   forward migration correcting the schema
  4. Data loss   ──────►   PITR restore to just before the migration
  5. Verify                run the database suite against the restored instance
  6. Resume
```

Step 5 is the one usually skipped. The suite exists precisely so a restored database can be
checked rather than assumed.

### The application is broken but the data is fine

Roll back the Vercel deployment. This is safe whenever the schema change was additive,
which is the common case. It is much faster than a database restore and should be the first
thing tried.

### A tenant's data was damaged by their own staff

This is more common than infrastructure failure, and Carl is built for it:

- The **inventory ledger** is append-only, so a wrong stock figure is corrected by posting
  an opposing movement, not by editing history. Nothing is lost.
- The **audit log** cannot be edited or deleted by anyone, including the service role.
- A **sale** is voided or returned, never deleted. Both leave a record.

A full restore should rarely be needed for this class of problem, and reaching for one
would discard other tenants' legitimate work.

### The database filled its disk

Observed, not hypothesised: a performance probe wrote 610,000 rows, took the project to
398 MB against a 500 MB limit, and PostgreSQL went read-only. Attempting to clean up made it
worse — the project stopped accepting connections altogether.

The trap is that **the obvious cleanup cannot run**. `DELETE` writes a WAL record per row,
so deleting data to free space needs space to write, and there is none:

```
error: could not write to file "pg_wal/xlogtemp.124226": No space left on device
```

What works:

1. **Wait for the project to accept connections.** It may be restarting. Retry on a loop
   rather than assuming it is gone — recovery here took several minutes of refusals
   (`the database system is not accepting connections`) before one attempt succeeded.

2. **Lift read-only for the session.** Supabase sets it as a protective default:

   ```sql
   set session characteristics as transaction read write;
   set default_transaction_read_only = off;
   ```

3. **`TRUNCATE`, never `DELETE`.** Truncation writes almost no WAL, which is the entire
   difference between recovering and not:

   ```sql
   truncate table public.sale_items cascade;
   truncate table public.sales cascade;
   ```

4. **Then reclaim.** `vacuum full` on the truncated tables, and `analyze`.

5. **Verify it is genuinely writable**, not merely reporting so — create a table, insert a
   row, drop it. `show transaction_read_only` returning `off` is not proof on its own.

**Prevention.** Alert on database size well before the limit; the failure mode is not
gradual. Note also that a tenant cannot be hard-deleted (`audit_logs` is append-only), so
"delete the test tenant" is not available as a space-recovery step — truncation of the bulk
tables is.

### A terminal was lost or stolen

No data recovery is needed — the terminal holds a catalogue and a queue, not the business.

```
  1. revoke_device(id, reason)      stops it at the next authorisation check
  2. Confirm queued sales           anything unsynced is lost with the device
  3. Issue a replacement            new terminal, new activation code
```

**Unsynced sales on a lost terminal are unrecoverable.** That is inherent to offline
selling and is the argument for a shorter `offline_grace_hours` at high-risk sites: the
window bounds both how long a stolen terminal can trade _and_ how much unsynced work can be
lost with it.

### An offline transaction failed to sync

The sync engine never discards a queued transaction. It ends as `SYNCED`, `CONFLICT`, or
`ABANDONED` — and `ABANDONED` means kept, not deleted.

```
  ABANDONED  ──►  visible in "needs attention" on the terminal
             ──►  the payload is intact and can be re-submitted
             ──►  or entered manually from the printed receipt
```

The customer's receipt is the backstop. It carries the receipt number, the items and the
total, which is enough to reconstruct the sale by hand.

## What must be tested before launch

None of the following has been done:

- [ ] Enable PITR on the production project
- [ ] Perform a restore to a scratch project and run `CARL_TEST_DB_DRIVER=pg pnpm test:db`
      against it
- [ ] Measure how long a restore actually takes, and write it down
- [ ] Rehearse the "migration went wrong" path on a copy
- [ ] Confirm the backup covers `auth.users` as well as `public`

The second item is the important one. A backup that has never been restored is not a backup.

## Recovery objectives

These are **targets**, not measurements. Nothing here has been timed.

| Objective              | Target                           | Measured |
| ---------------------- | -------------------------------- | -------- |
| RPO (data loss)        | < 5 minutes with PITR            | ⬜       |
| RTO (application)      | < 15 minutes via Vercel rollback | ⬜       |
| RTO (database restore) | < 1 hour                         | ⬜       |
| Terminal replacement   | < 30 minutes                     | ⬜       |
