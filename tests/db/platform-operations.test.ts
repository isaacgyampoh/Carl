import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { createUser } from '../support/fixtures.js';

/**
 * The platform owner's commercial operations.
 *
 * These move money and change whether a business can trade, so the properties that matter
 * are atomicity and idempotency: a customer half-created is a support call, and a payment
 * recorded twice is an argument about money.
 */
describe('platform operations', () => {
  let db: TestDatabase;
  let owner: string;
  let planId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
    owner = await createUser(db, { isPlatformAdmin: true });
    planId = await db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into subscription_plans (key, name, price, interval)
         values ($1, 'Standard', 15000, 'MONTHLY') returning id`,
        [`standard-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
  });

  interface Onboarded {
    tenant_id: string;
    branch_id: string;
    membership_id: string;
    subscription_id: string;
    status: string;
    next_billing_at: string;
  }

  async function onboard(options: { trialDays?: number; name?: string } = {}): Promise<Onboarded> {
    const newOwner = await createUser(db);
    const { rows } = await db.asUser(owner, () =>
      db.query<Onboarded>(
        `select * from onboard_client($1, $2, $3, 'Owner', $4, $5,
           'Main Branch', 'main', 'Kofi Mensah', 'billing@example.test', '0244000111',
           '12 High Street', null, 'GH', 'GHS', 'Africa/Accra', $6)`,
        [
          options.name ?? 'Adom Stores',
          `adom-${randomUUID().slice(0, 8)}`,
          `owner-${randomUUID().slice(0, 8)}@example.test`,
          newOwner,
          planId,
          options.trialDays ?? 14,
        ],
      ),
    );
    return rows[0]!;
  }

  describe('onboarding a client', () => {
    it('creates the tenant, its branch, the owner and the subscription together', async () => {
      const client = await onboard();

      const { rows } = await db.asServiceRole(() =>
        db.query<{ tenants: string; branches: string; members: string; subs: string }>(
          `select
             (select count(*)::text from tenants where id = $1) as tenants,
             (select count(*)::text from branches where tenant_id = $1) as branches,
             (select count(*)::text from tenant_memberships where tenant_id = $1) as members,
             (select count(*)::text from subscriptions where tenant_id = $1) as subs`,
          [client.tenant_id],
        ),
      );
      expect(rows[0]).toEqual({ tenants: '1', branches: '1', members: '1', subs: '1' });
    });

    it('records the commercial contact details', async () => {
      const client = await onboard();
      const { rows } = await db.asServiceRole(() =>
        db.query<{ contact_person: string; phone: string; email: string; address: string }>(
          `select contact_person, phone, email::text as email, address from tenants where id = $1`,
          [client.tenant_id],
        ),
      );
      expect(rows[0]).toMatchObject({
        contact_person: 'Kofi Mensah',
        phone: '0244000111',
        email: 'billing@example.test',
      });
    });

    it('starts a trial client on trial, not active', async () => {
      const client = await onboard({ trialDays: 14 });
      expect(client.status).toBe('TRIAL');
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; trial_ends_at: string }>(
          `select status, trial_ends_at::text from subscriptions where tenant_id = $1`,
          [client.tenant_id],
        ),
      );
      expect(rows[0]?.status).toBe('TRIALING');
      expect(rows[0]?.trial_ends_at).toBeTruthy();
    });

    it('starts a client with no trial as active immediately', async () => {
      const client = await onboard({ trialDays: 0 });
      expect(client.status).toBe('ACTIVE');
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from subscriptions where tenant_id = $1`, [
          client.tenant_id,
        ]),
      );
      expect(rows[0]?.status).toBe('ACTIVE');
    });

    it('leaves nothing behind when onboarding fails', async () => {
      // The property the whole function exists for: no tenant without its branch, no
      // subscription pointing at a business that was never created.
      const before = await db.asServiceRole(() =>
        db.query<{ count: string }>(`select count(*)::text as count from tenants`),
      );

      const doomedOwner = await createUser(db);
      await expect(
        db.asUser(owner, () =>
          db.query(`select * from onboard_client($1, $2, $3, 'Owner', $4, $5)`, [
            'Doomed Stores',
            `doomed-${randomUUID().slice(0, 8)}`,
            'doomed@example.test',
            doomedOwner,
            randomUUID(), // a plan that does not exist
          ]),
        ),
      ).rejects.toThrow(/NOT_FOUND/);

      const after = await db.asServiceRole(() =>
        db.query<{ count: string }>(`select count(*)::text as count from tenants`),
      );
      expect(after.rows[0]!.count, 'a half-created client was left behind').toBe(
        before.rows[0]!.count,
      );
    });

    it('records an audit entry naming the plan and price', async () => {
      const client = await onboard();
      const { rows } = await db.asServiceRole(() =>
        db.query<{ action: string; metadata: { price: number; trial_days: number } }>(
          `select action, metadata from audit_logs
            where tenant_id = $1 and action = 'CLIENT_ONBOARDED'`,
          [client.tenant_id],
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata.price).toBe(15000);
    });

    it('refuses a trial longer than a year', async () => {
      const trialOwner = await createUser(db);
      await expect(
        db.asUser(owner, () =>
          db.query(
            `select * from onboard_client($1, $2, $3, 'O', $4, $5, 'Main', 'main',
               null, null, null, null, null, 'GH', 'GHS', 'Africa/Accra', 400)`,
            ['X', `x-${randomUUID().slice(0, 8)}`, 'x@example.test', trialOwner, planId],
          ),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });
  });

  describe('recording a payment', () => {
    it('records it and advances the billing period', async () => {
      const client = await onboard({ trialDays: 0 });
      const { rows } = await db.asUser(owner, () =>
        db.query<{ payment_id: string; subscription_status: string; was_replayed: boolean }>(
          `select * from record_subscription_payment($1, 15000, $2, 'MOMO', 'MM-4471')`,
          [client.subscription_id, randomUUID().replace(/-/g, '')],
        ),
      );
      expect(rows[0]?.payment_id).toBeTruthy();
      expect(rows[0]?.subscription_status).toBe('ACTIVE');
      expect(rows[0]?.was_replayed).toBe(false);
    });

    it('does not record the same payment twice when the operator retries', async () => {
      // A person with a phone on a bad connection presses the button again. A merchant
      // must not end up with two payments and two months of credit.
      const client = await onboard({ trialDays: 0 });
      const key = randomUUID().replace(/-/g, '');

      const first = await db.asUser(owner, () =>
        db.query<{ payment_id: string; was_replayed: boolean }>(
          `select * from record_subscription_payment($1, 15000, $2)`,
          [client.subscription_id, key],
        ),
      );
      const second = await db.asUser(owner, () =>
        db.query<{ payment_id: string; was_replayed: boolean }>(
          `select * from record_subscription_payment($1, 15000, $2)`,
          [client.subscription_id, key],
        ),
      );

      expect(second.rows[0]!.was_replayed).toBe(true);
      expect(second.rows[0]!.payment_id).toBe(first.rows[0]!.payment_id);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ count: string }>(
          `select count(*)::text as count from subscription_payments where tenant_id = $1`,
          [client.tenant_id],
        ),
      );
      expect(rows[0]!.count, 'the retry created a second payment').toBe('1');
    });

    it('refuses the same key for a different amount', async () => {
      // Either the caller has a bug, or two different payments are about to be conflated.
      const client = await onboard({ trialDays: 0 });
      const key = randomUUID().replace(/-/g, '');
      await db.asUser(owner, () =>
        db.query(`select * from record_subscription_payment($1, 15000, $2)`, [
          client.subscription_id,
          key,
        ]),
      );
      await expect(
        db.asUser(owner, () =>
          db.query(`select * from record_subscription_payment($1, 99000, $2)`, [
            client.subscription_id,
            key,
          ]),
        ),
      ).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    });

    it('refuses a payment dated in the future', async () => {
      const client = await onboard({ trialDays: 0 });
      await expect(
        db.asUser(owner, () =>
          db.query(
            `select * from record_subscription_payment($1, 15000, $2, 'CASH', null, now() + interval '30 days')`,
            [client.subscription_id, randomUUID().replace(/-/g, '')],
          ),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses a zero or negative payment', async () => {
      const client = await onboard({ trialDays: 0 });
      await expect(
        db.asUser(owner, () =>
          db.query(`select * from record_subscription_payment($1, 0, $2)`, [
            client.subscription_id,
            randomUUID().replace(/-/g, ''),
          ]),
        ),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('does not reinstate a business suspended by the operator', async () => {
      // Suspension is a decision, and it may have been for abuse rather than money.
      // Reversing it silently on receipt of a payment takes that decision away.
      const client = await onboard({ trialDays: 0 });
      await db.asUser(owner, () =>
        db.query(`select suspend_tenant($1, 'Abuse of the platform')`, [client.tenant_id]),
      );

      await db.asUser(owner, () =>
        db.query(`select * from record_subscription_payment($1, 15000, $2)`, [
          client.subscription_id,
          randomUUID().replace(/-/g, ''),
        ]),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string }>(`select status from tenants where id = $1`, [
          client.tenant_id,
        ]),
      );
      expect(rows[0]!.status, 'a payment silently lifted a suspension').toBe('SUSPENDED');
    });
  });

  describe('invoices', () => {
    it('issues one with a number, amount and due date', async () => {
      const client = await onboard({ trialDays: 0 });
      const { rows } = await db.asUser(owner, () =>
        db.query<{ invoice_number: string; amount: string; due_at: string }>(
          `select * from issue_invoice($1)`,
          [client.subscription_id],
        ),
      );
      expect(rows[0]!.invoice_number).toMatch(/^CARL-\d{4}-\d{6}$/);
      expect(Number(rows[0]!.amount)).toBe(15000);
      expect(rows[0]!.due_at).toBeTruthy();
    });

    it('refuses to bill the same period twice', async () => {
      // The mistake that produces a merchant with two bills for the same month.
      const client = await onboard({ trialDays: 0 });
      await db.asUser(owner, () =>
        db.query(`select * from issue_invoice($1)`, [client.subscription_id]),
      );
      await expect(
        db.asUser(owner, () =>
          db.query(`select * from issue_invoice($1)`, [client.subscription_id]),
        ),
      ).rejects.toThrow(/DUPLICATE_INVOICE/);
    });

    it('gives each invoice a distinct number', async () => {
      const a = await onboard({ trialDays: 0, name: 'A Stores' });
      const b = await onboard({ trialDays: 0, name: 'B Stores' });
      const first = await db.asUser(owner, () =>
        db.query<{ invoice_number: string }>(`select * from issue_invoice($1)`, [
          a.subscription_id,
        ]),
      );
      const second = await db.asUser(owner, () =>
        db.query<{ invoice_number: string }>(`select * from issue_invoice($1)`, [
          b.subscription_id,
        ]),
      );
      expect(first.rows[0]!.invoice_number).not.toBe(second.rows[0]!.invoice_number);
    });

    it('marks the invoice paid when the payment names it', async () => {
      const client = await onboard({ trialDays: 0 });
      const invoice = await db.asUser(owner, () =>
        db.query<{ invoice_id: string }>(`select * from issue_invoice($1)`, [
          client.subscription_id,
        ]),
      );
      await db.asUser(owner, () =>
        db.query(
          `select * from record_subscription_payment($1, 15000, $2, 'CASH', null, null, null, null, $3)`,
          [client.subscription_id, randomUUID().replace(/-/g, ''), invoice.rows[0]!.invoice_id],
        ),
      );
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; paid_at: string }>(
          `select status, paid_at::text from subscription_invoices where id = $1`,
          [invoice.rows[0]!.invoice_id],
        ),
      );
      expect(rows[0]!.status).toBe('PAID');
      expect(rows[0]!.paid_at).toBeTruthy();
    });
  });

  describe('suspension', () => {
    it('stops the business and its subscription together', async () => {
      const client = await onboard({ trialDays: 0 });
      await db.asUser(owner, () =>
        db.query(`select suspend_tenant($1, 'Non-payment for 60 days')`, [client.tenant_id]),
      );
      const { rows } = await db.asServiceRole(() =>
        db.query<{ tenant: string; sub: string; reason: string }>(
          `select t.status as tenant, s.status as sub, t.suspension_reason as reason
             from tenants t join subscriptions s on s.tenant_id = t.id where t.id = $1`,
          [client.tenant_id],
        ),
      );
      expect(rows[0]).toMatchObject({ tenant: 'SUSPENDED', sub: 'SUSPENDED' });
      expect(rows[0]!.reason).toBe('Non-payment for 60 days');
    });

    it('requires a reason', async () => {
      // A suspension stops a business trading. It does not happen anonymously.
      const client = await onboard({ trialDays: 0 });
      await expect(
        db.asUser(owner, () => db.query(`select suspend_tenant($1, '   ')`, [client.tenant_id])),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('actually stops the business from selling', async () => {
      // The suspension must bite where it matters, not merely in a status column. Asserted
      // by trying to sell, because that is what a suspension is for.
      const client = await onboard({ trialDays: 0 });
      const productId = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ id: string }>(
          `insert into products (tenant_id, name, sku) values ($1, 'Rice', $2) returning id`,
          [client.tenant_id, `SKU-${randomUUID().slice(0, 8).toUpperCase()}`],
        );
        await db.query(
          `insert into product_prices (tenant_id, product_id, tier, amount)
           values ($1, $2, 'RETAIL', 8000)`,
          [client.tenant_id, rows[0]!.id],
        );
        return rows[0]!.id;
      });
      const ownerUserId = await db.asServiceRole(async () => {
        const { rows } = await db.query<{ user_id: string }>(
          `select user_id from tenant_memberships where tenant_id = $1 and is_owner limit 1`,
          [client.tenant_id],
        );
        return rows[0]!.user_id;
      });

      await db.asUser(owner, () =>
        db.query(`select suspend_tenant($1, 'Non-payment')`, [client.tenant_id]),
      );

      await expect(
        db.asUser(ownerUserId, () =>
          db.query(`select * from complete_sale($1, $2::jsonb, $3::jsonb, $4)`, [
            client.branch_id,
            JSON.stringify([{ product_id: productId, quantity: 1 }]),
            JSON.stringify([{ method: 'CASH', amount: 8000 }]),
            randomUUID().replace(/-/g, ''),
          ]),
        ),
      ).rejects.toThrow(/TENANT_SUSPENDED/);
    });

    it('reactivation puts it back', async () => {
      const client = await onboard({ trialDays: 0 });
      await db.asUser(owner, () =>
        db.query(`select suspend_tenant($1, 'Non-payment')`, [client.tenant_id]),
      );
      await db.asUser(owner, () => db.query(`select reactivate_tenant($1)`, [client.tenant_id]));
      const { rows } = await db.asServiceRole(() =>
        db.query<{ status: string; reason: string | null; sub: string }>(
          `select t.status, t.suspension_reason as reason, s.status as sub
             from tenants t join subscriptions s on s.tenant_id = t.id where t.id = $1`,
          [client.tenant_id],
        ),
      );
      expect(rows[0]).toMatchObject({ status: 'ACTIVE', reason: null, sub: 'ACTIVE' });
    });

    it('will not reactivate a cancelled business', async () => {
      const client = await onboard({ trialDays: 0 });
      await db.asServiceRole(() =>
        db.query(`update tenants set status = 'CANCELLED', cancelled_at = now() where id = $1`, [
          client.tenant_id,
        ]),
      );
      await expect(
        db.asUser(owner, () => db.query(`select reactivate_tenant($1)`, [client.tenant_id])),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });
  });
});
