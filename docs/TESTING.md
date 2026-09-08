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

Before a release, the identical suite is pointed at a real Supabase instance
(`CARL_TEST_DB_DRIVER=pg`, wired up in Phase 15). The assertions do not change.

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

## Conventions

- **Test behaviour, not implementation.** "A cashier cannot refund" survives refactoring;
  "`canRefund()` returns false" does not.
- **Name the guarantee.** `it('refuses a write that forges another user as the owner')`.
- **Prefer a fixture over a mock.** Carl's fixtures build real rows through real constraints,
  which catches schema mistakes a mock hides.
- **A concurrency bug needs a concurrency test.** Two terminals selling the last unit is a
  scenario, not a hypothetical.
