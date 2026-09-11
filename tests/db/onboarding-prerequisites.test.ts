import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * What has to be true before a customer can be created at all.
 *
 * The ONBOARD CLIENT button did nothing in production, and nothing was wrong with the button,
 * the server action, the transaction or the database function. `subscription_plans` was empty:
 * plans had no seed of any kind, so a real deployment started with none. The form loads the
 * plan list, defaults its selector to `plans[0]?.id ?? ''`, and validates it as a uuid — so
 * with no plans the form failed its own validation before anything was ever sent.
 *
 * A defect with no failing request is a defect nobody can trace from a log, which is why this
 * is asserted on the data rather than on the flow that consumes it.
 */
describe('onboarding prerequisites', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('ships at least one active plan, so onboarding always has a valid answer', async () => {
    /*
     * NOT reset() first, deliberately: this is about what the MIGRATIONS leave behind, and
     * the harness truncates `subscription_plans` between tests. Truncating first would test
     * the fixture rather than the deployment.
     */
    const { rows } = await db.asServiceRole(() =>
      db.query<{ n: number }>(`select count(*)::int as n from subscription_plans where is_active`),
    );
    expect(rows[0]!.n, 'no active plan: a business cannot be created').toBeGreaterThan(0);
  });

  it('has exactly one standard plan, and re-running the migration cannot add another', async () => {
    // The seed is `on conflict (key) do nothing`, so this is the assertion that keeps it so.
    const { rows } = await db.asServiceRole(() =>
      db.query<{ n: number }>(
        `select count(*)::int as n from subscription_plans where key = 'standard'`,
      ),
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('charges nothing and caps nothing, because billing is collected by hand today', async () => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{
        price: string;
        max_branches: number | null;
        max_devices: number | null;
        max_users: number | null;
      }>(
        `select price::text, max_branches, max_devices, max_users
           from subscription_plans where key = 'standard'`,
      ),
    );
    const plan = rows[0]!;
    // A limit here is a real constraint enforced at provisioning, not a marketing line — so
    // an accidental one would refuse a customer their branches or terminals.
    expect(Number(plan.price)).toBe(0);
    expect(plan.max_branches).toBeNull();
    expect(plan.max_devices).toBeNull();
    expect(plan.max_users).toBeNull();
  });

  it('keeps the columns real plans will need, so billing later is an insert', async () => {
    const { rows } = await db.asServiceRole(() =>
      db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'subscription_plans'`,
      ),
    );
    const columns = rows.map((r) => r.column_name);
    for (const needed of ['price', 'currency_code', 'interval', 'max_branches', 'is_active']) {
      expect(columns, `subscription_plans lost ${needed}`).toContain(needed);
    }
  });
});
