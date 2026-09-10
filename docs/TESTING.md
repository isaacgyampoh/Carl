# Testing

## The gate

```bash
pnpm verify      # typecheck → lint → test → build
```

CI runs the same steps as parallel jobs and does not fast-fail, so one push reports every
problem rather than the first one.

## The pyramid

| Layer          | Location                      | Runtime | What it proves                                         |
| -------------- | ----------------------------- | ------- | ------------------------------------------------------ |
| Unit           | `packages/*/src/**/*.test.ts` | ms      | Domain rules: totals, rounding, discounts, permissions |
| Database & RLS | `tests/db/**`                 | seconds | Constraints hold; tenants cannot reach each other      |
| Integration    | `tests/integration/**`        | seconds | Use cases against a real schema                        |
| E2E            | `tests/e2e/**` _(Phase 15)_   | minutes | Critical flows through the real UI                     |

```bash
pnpm test:unit    # fast; run constantly
pnpm test:db      # real PostgreSQL; run before every commit
pnpm test         # both
```

## Database tests run real PostgreSQL — without Docker

Carl's tenant isolation lives in PostgreSQL Row Level Security. **A test that mocks the
database proves nothing about it.** To have any value, a security test must apply the real
migrations to a real PostgreSQL instance and query it as the real `authenticated` role with
real JWT claims.

The harness (`tests/support/test-database.ts`) does exactly that using
[PGlite](https://pglite.dev) — PostgreSQL 18 compiled to WebAssembly and run in-process. It is
genuinely PostgreSQL: the same planner, the same `plpgsql`, the same RLS enforcement. No
Docker, no daemon, no ports.

That choice is deliberate. A security suite that requires Docker to be running is a security
suite that gets skipped, and skipped security tests are worse than none because they imply
coverage that does not exist.

`tests/support/supabase-shim.sql` recreates the objects a hosted Supabase project provides —
the `auth` schema, `auth.uid()`, and the `anon` / `authenticated` / `service_role` roles — so
migrations apply unchanged and policies are exercised exactly as written. The shim is applied
only by the harness and never reaches a deployed database.

### Running against real Supabase

The identical suite runs against a real project. The assertions do not change; only where
they execute does.

> **This suite destroys the database it runs against.** It requires a **separate Supabase
> project that exists only for verification**. Never point it at the project serving shops,
> and never at the project a deployment's `SUPABASE_URL` names. See _Why there are two
> projects_ below — this is not a precaution, it is a recovery of something that already
> went wrong.

```bash
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres'
export CARL_TEST_DB_DRIVER=pg
export CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes
pnpm test:db
```

Four things about that command matter.

**Use the session-mode pooler (port 5432), not transaction mode (6543).** The suite relies
on `SET ROLE` and explicit transactions persisting across statements; transaction-mode
pooling hands each statement to a different backend and the identity is lost between them.

**`CARL_ALLOW_DESTRUCTIVE_DB_TESTS=yes` is not a formality.** The suite truncates every
application table. The driver refuses to start without it, so a mistyped connection string
cannot quietly destroy a real database. Point it at a disposable verification project.

**The database must declare itself disposable.** The driver refuses to run unless the target
carries a marker table. Create it once, on the verification project only:

```sql
create table if not exists public.carl_disposable_verification_marker ();
```

Nothing in the codebase creates that table. A guard that can arm itself will eventually arm
itself against the wrong database.

### Why there are two projects

`reset()` runs before **every test** and executes, among other things:

```sql
truncate table auth.users cascade;
```

That deletes every authentication account in the project, cascading to `profiles` and
`platform_admins`. It is correct for a throwaway database and catastrophic anywhere else.

This is not hypothetical. The suite was pointed at the only Carl project — the one the
deployed application used — and the platform owner's account was destroyed and replaced by
`@example.test` fixtures. The owner was told "That PIN is not correct", which was true of an
account that no longer existed, and the cause took a full authentication trace to find.

`CARL_ALLOW_DESTRUCTIVE_DB_TESTS` did not prevent it and could not: it records that an
operator consented once, in a shell, and it travels separately from the connection string.
The marker lives inside the target instead, so a stale or mistyped `SUPABASE_DB_URL` fails
closed rather than silently truncating.

Two further things belong on any project holding real data: **point-in-time recovery
enabled** (daily logical backups alone can be hours stale, and were), and a connection
string that never sits in the same shell profile as the verification one.

**It is slow.** Every query is a network round-trip; a run that takes 50 seconds locally
takes around 35 minutes remotely. It is a pre-release gate, not something to run on save.
The property test's sample size drops automatically on this driver and can be restored with
`CARL_PROPERTY_ITERATIONS`.

### What only the real driver can prove

Two things, and both matter:

**Concurrency.** PGlite is an embedded single-connection engine, so two tills contending
for the same stock row cannot be expressed at all. `tests/db/real-concurrency.test.ts` opens
two genuine sessions and asserts the _final database state_, not merely that both requests
returned.

**Supabase itself.** The `auth` schema, the API roles and the extension layout are
recreated locally by `supabase-shim.sql`. A shim is a model, and a model can be wrong — the
first real run surfaced four cases where it was more permissive than production, including
`anon` holding 364 table grants that the shim never issued. Each has been corrected so the
local suite would now catch the same thing.

**If the shim is ever more permissive than production, it hides the bugs it exists to
catch.** That is the single rule to keep in mind when editing it.

### Writing one

```ts
const db = await createTestDatabase(); // migrated, isolated

await db.asUser(aliceId, async () => {
  // real role + real JWT claims
  const { rows } = await db.query('select * from products');
  expect(rows).toHaveLength(1); // only her tenant's
});

await db.asUser(aliceId, () =>
  // writes are refused outright
  db.expectDenied('insert into products (tenant_id, name) values ($1, $2)', [bobTenant, 'x']),
);
```

`asUser`, `asAnon` and `asServiceRole` restore the previous identity even when the body
throws, so a failing test cannot leave the connection impersonating someone else.

### Reads and writes fail differently

RLS refuses a **read** by returning zero rows, and a **write** with SQLSTATE 42501. A test for
unauthorised reading must assert emptiness; `expectDenied` covers writes.

`expectDenied` is strict about _why_ a statement failed. A query that fails because of a typo
would otherwise look like a passing security test — so a non-privilege error is reported as a
harness failure, not a pass. `tests/db/harness.test.ts` includes a negative control proving
this.

### The harness is itself tested

`tests/db/harness.test.ts` asserts that the connection really is PostgreSQL, that `SET ROLE`
really took effect (`current_user = 'authenticated'`, not superuser), that `auth.uid()`
resolves, and that a cross-tenant write is genuinely refused. If the shim were subtly wrong the
entire RLS suite would pass while proving nothing; these tests fail loudly in that case.

## Keeping the suite trustworthy

Two problems were found and fixed here, and both are worth knowing about because they
recur.

**A test that cannot fail is worse than no test.** Every detector in this suite has been
verified against a deliberate defect: the RLS coverage checks were run against an
unprotected table and an unpinned `SECURITY DEFINER` function; the cart/database agreement
suite was run with `roundHalfAwayFromZero` swapped for `Math.floor` and correctly reported
_"the till showed 850 but the customer was charged 849"_. A green test that cannot detect
the problem it names implies coverage that does not exist.

**Intermittent failures are diagnosed, not re-run.** The suite once failed roughly one run
in three, in a _different_ file each time. Two causes, neither of them a race:

1. `beforeEach` hooks were timing out because several test suites were being run
   concurrently on the same machine, starving each other. One file took 699 seconds
   against a whole-suite time of 52.
2. Fixture identifiers combined `Date.now()` with a module-scoped counter, and each test
   file gets its own counter — so two files could collide on `tenants.slug` in the same
   millisecond.

A third issue nearly hid the first: a Vitest configuration change was silently ignored
(`poolOptions` was removed in Vitest 4) and only warned about in output that was being
filtered away by a `grep`. **Read the warnings.**

`reset()` runs before every test, so it truncates only tables that actually hold rows
rather than all fifty-odd. At that call frequency the difference is most of the suite's
runtime.

## Conventions

- **Test behaviour, not implementation.** "A cashier cannot refund" survives refactoring;
  "`canRefund()` returns false" does not.
- **Name the guarantee.** `it('refuses a write that forges another user as the owner')`.
- **Prefer a fixture over a mock.** Carl's fixtures build real rows through real constraints,
  which catches schema mistakes a mock hides.
- **A concurrency bug needs a concurrency test.** Two terminals selling the last unit is a
  scenario, not a hypothetical.
