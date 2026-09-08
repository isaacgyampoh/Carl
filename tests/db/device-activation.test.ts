import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { addMember, createTenant } from '../support/fixtures.js';

/**
 * Device activation and authorisation.
 *
 * A POS terminal is a second identity alongside the cashier's. It exists because a login
 * says who is selling but not which physical till the money went into, which drawer to
 * reconcile, or what to do when a laptop running Carl is stolen — revoking the employee's
 * account leaves the machine's cached credentials working.
 *
 * Activation codes and device secrets are bearer credentials, so these tests treat them as
 * such: never stored in plaintext, single-use, short-lived, revocable, and bounded in how
 * long they keep working without contact.
 */
describe('device activation', () => {
  let db: TestDatabase;

  // Stands in for CARL_DEVICE_SECRET_PEPPER, which lives in the server environment and is
  // deliberately never stored in the database.
  const PEPPER = 'test-pepper-not-a-real-secret-value-000000';

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.reset();
  });

  async function createDevice(
    tenantId: string,
    branchId: string,
    code = 'pos-accra-001',
  ): Promise<string> {
    return db.asServiceRole(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into devices (tenant_id, branch_id, code, name) values ($1, $2, $3, 'Till 1') returning id`,
        [tenantId, branchId, code],
      );
      return rows[0]!.id;
    });
  }

  async function issueCode(
    actorId: string,
    deviceId: string,
    validHours = 24,
  ): Promise<{ code: string; expiresAt: string }> {
    const { rows } = await db.asUser(actorId, () =>
      db.query<{ code: string; expires_at: string }>(
        `select * from issue_activation_code($1, $2, $3)`,
        [deviceId, PEPPER, validHours],
      ),
    );
    return { code: rows[0]!.code, expiresAt: rows[0]!.expires_at };
  }

  function activate(code: string, installId = 'install-1') {
    return db.asServiceRole(() =>
      db.query<{
        device_id: string;
        tenant_id: string;
        branch_id: string;
        device_secret: string;
        authorized_until: string;
      }>(`select * from activate_device($1, $2, $3, 'WINDOWS', '1.0.0')`, [
        code,
        PEPPER,
        installId,
      ]),
    );
  }

  describe('issuing a code', () => {
    it('produces a typable code with no easily-confused characters', async () => {
      // An installer transcribes this by hand in a shop. I, O, 0 and 1 are misread
      // constantly, so the alphabet excludes them.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      expect(code).toHaveLength(12);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
    });

    it('never stores the code, only a peppered hash', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      const { rows } = await db.asServiceRole(() =>
        db.query<{ code_hash: string; code_hint: string }>(
          `select encode(code_hash, 'hex') as code_hash, code_hint from device_activations where device_id = $1`,
          [device],
        ),
      );

      expect(rows[0]!.code_hash).not.toContain(code);
      expect(rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
      // The hint lets support identify which code is being discussed without handling one.
      expect(rows[0]!.code_hint).toBe(code.slice(-4));
    });

    it('produces a different code every time', async () => {
      const t = await createTenant(db);
      const codes = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const device = await createDevice(t.tenantId, t.branchId, `pos-${i}`);
        codes.add((await issueCode(t.ownerUserId, device)).code);
      }
      expect(codes.size, 'activation codes repeated').toBe(12);
    });

    it('invalidates an outstanding code when a new one is issued', async () => {
      // A code left in an old email must stop working the moment it is superseded.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);

      const first = await issueCode(t.ownerUserId, device);
      const second = await issueCode(t.ownerUserId, device);

      await expect(activate(first.code)).rejects.toThrow(/ACTIVATION_CODE_INVALID/);
      await expect(activate(second.code, 'install-2')).resolves.toBeTruthy();
    });

    it('refuses a window longer than 48 hours', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      await expect(issueCode(t.ownerUserId, device, 240)).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses a caller without devices.manage', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      await expect(issueCode(userId, device)).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to issue a code for another tenant’s device', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      const foreignDevice = await createDevice(b.tenantId, b.branchId);

      await expect(issueCode(a.ownerUserId, foreignDevice)).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it('refuses to issue a code for a revoked device', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      await db.asUser(t.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Stolen from the shop')`, [device]),
      );
      await expect(issueCode(t.ownerUserId, device)).rejects.toThrow(/DEVICE_REVOKED/);
    });
  });

  describe('activating', () => {
    it('activates the terminal and issues a secret', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      const { rows } = await activate(code);
      expect(rows[0]!.device_id).toBe(device);
      expect(rows[0]!.tenant_id).toBe(t.tenantId);
      expect(rows[0]!.branch_id).toBe(t.branchId);
      // 32 bytes of CSPRNG output, hex-encoded.
      expect(rows[0]!.device_secret).toMatch(/^[0-9a-f]{64}$/);

      const device_row = await db.asServiceRole(() =>
        db.query<{ status: string; activated_at: string | null }>(
          `select status, activated_at from devices where id = $1`,
          [device],
        ),
      );
      expect(device_row.rows[0]!.status).toBe('ACTIVE');
      expect(device_row.rows[0]!.activated_at).not.toBeNull();
    });

    it('never stores the secret, only a peppered hash', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);
      const { rows } = await activate(code);
      const secret = rows[0]!.device_secret;

      const stored = await db.asServiceRole(() =>
        db.query<{ hash: string }>(
          `select encode(secret_hash, 'hex') as hash from devices where id = $1`,
          [device],
        ),
      );
      expect(stored.rows[0]!.hash).not.toContain(secret);
      expect(stored.rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects a wrong code indistinguishably from a non-existent one', async () => {
      // Both must be ACTIVATION_CODE_INVALID: a different error for "exists but wrong"
      // would confirm which codes are real.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      await issueCode(t.ownerUserId, device);

      await expect(activate('AAAAAAAAAAAA')).rejects.toThrow(/ACTIVATION_CODE_INVALID/);
      await expect(activate('ZZZZZZZZZZZZ')).rejects.toThrow(/ACTIVATION_CODE_INVALID/);
    });

    it('rejects a code presented with the wrong pepper', async () => {
      // The pepper lives in the server environment. A stolen database alone is not enough.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      await expect(
        db.asServiceRole(() =>
          db.query(`select * from activate_device($1, 'the-wrong-pepper', 'install-x')`, [code]),
        ),
      ).rejects.toThrow(/ACTIVATION_CODE_INVALID/);
    });

    it('rejects an expired code', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device, 1);

      // A CHECK requires expires_at to be after created_at, so a code cannot be created
      // already expired. Expiry is simulated by ageing the whole row, which is what
      // actually happens with the passage of time.
      await db.asServiceRole(() =>
        db.query(
          `update device_activations
              set created_at = now() - interval '3 hours',
                  expires_at = now() - interval '1 minute'
            where device_id = $1`,
          [device],
        ),
      );

      await expect(activate(code)).rejects.toThrow(/ACTIVATION_CODE_EXPIRED/);
    });

    it('refuses a second, different installation using the same code', async () => {
      // Single-use. A code shared between two tills must activate only one.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      await activate(code, 'install-first');
      await expect(activate(code, 'install-second')).rejects.toThrow(/ACTIVATION_CODE_CONSUMED/);
    });

    it('lets the same installation retry after a lost response', async () => {
      // Installations happen in shops on unreliable connections. Without this, a dropped
      // response leaves the installer with a till that is activated but has no secret.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      const first = await activate(code, 'install-same');
      const retry = await activate(code, 'install-same');

      expect(retry.rows[0]!.device_id).toBe(first.rows[0]!.device_id);
      expect(retry.rows[0]!.device_secret).toMatch(/^[0-9a-f]{64}$/);

      // Exactly one session, not two.
      const sessions = await db.asServiceRole(() =>
        db.query<{ n: number }>(
          `select count(*)::int as n from device_sessions where device_id = $1`,
          [device],
        ),
      );
      expect(sessions.rows[0]!.n).toBe(1);
    });

    it('refuses to activate a terminal belonging to a suspended tenant', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [t.tenantId],
        ),
      );

      await expect(activate(code)).rejects.toThrow(/TENANT_SUSPENDED/);
    });

    it('is not callable by an ordinary authenticated user', async () => {
      // Activation runs server-side as the service role. The terminal is not yet trusted
      // and has no session of its own.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);

      await expect(
        db.asUser(t.ownerUserId, () =>
          db.query(`select * from activate_device($1, $2, 'install-x')`, [code, PEPPER]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('authorising an activated terminal', () => {
    async function activated() {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);
      const { rows } = await activate(code);
      return { t, device, secret: rows[0]!.device_secret };
    }

    it('authorises a healthy terminal', async () => {
      const { device, secret } = await activated();
      const { rows } = await db.asServiceRole(() =>
        db.query<{ ok: boolean }>(`select app.authorize_device($1, $2, $3) as ok`, [
          device,
          secret,
          PEPPER,
        ]),
      );
      expect(rows[0]!.ok).toBe(true);
    });

    it('refuses a wrong secret', async () => {
      const { device } = await activated();
      await expect(
        db.asServiceRole(() =>
          db.query(`select app.authorize_device($1, $2, $3)`, [device, 'f'.repeat(64), PEPPER]),
        ),
      ).rejects.toThrow(/DEVICE_NOT_ACTIVATED/);
    });

    it('refuses once the offline authorisation window has passed', async () => {
      // The bound on how long a stolen terminal keeps trading without contact.
      const { device, secret } = await activated();
      await db.asServiceRole(() =>
        db.query(
          `update devices set authorized_until = now() - interval '1 minute' where id = $1`,
          [device],
        ),
      );

      await expect(
        db.asServiceRole(() =>
          db.query(`select app.authorize_device($1, $2, $3)`, [device, secret, PEPPER]),
        ),
      ).rejects.toThrow(/DEVICE_AUTHORIZATION_EXPIRED/);
    });

    it('refuses a revoked terminal immediately, not at the end of its window', async () => {
      const { t, device, secret } = await activated();

      await db.asUser(t.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Reported stolen')`, [device]),
      );

      await expect(
        db.asServiceRole(() =>
          db.query(`select app.authorize_device($1, $2, $3)`, [device, secret, PEPPER]),
        ),
      ).rejects.toThrow(/DEVICE_REVOKED/);
    });

    it('refuses a terminal whose tenant has been suspended', async () => {
      const { t, device, secret } = await activated();
      await db.asServiceRole(() =>
        db.query(
          `update tenants set status = 'SUSPENDED', suspended_at = now(), suspension_reason = 'Non-payment' where id = $1`,
          [t.tenantId],
        ),
      );

      await expect(
        db.asServiceRole(() =>
          db.query(`select app.authorize_device($1, $2, $3)`, [device, secret, PEPPER]),
        ),
      ).rejects.toThrow(/TENANT_SUSPENDED/);
    });
  });

  describe('revocation', () => {
    it('clears the credential and the offline window, and closes every session', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);
      await activate(code);

      await db.asUser(t.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Reported stolen')`, [device]),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query<{
          status: string;
          secret_hash: string | null;
          reason: string;
          live_sessions: number;
        }>(
          `select d.status, d.secret_hash, d.revoked_reason as reason,
                  (select count(*)::int from device_sessions s
                     where s.device_id = d.id and s.revoked_at is null) as live_sessions
           from devices d where d.id = $1`,
          [device],
        ),
      );

      expect(rows[0]!.status).toBe('REVOKED');
      expect(rows[0]!.secret_hash).toBeNull();
      expect(rows[0]!.reason).toBe('Reported stolen');
      expect(rows[0]!.live_sessions).toBe(0);
    });

    it('requires a reason', async () => {
      // "Why is this till dead" must be answerable later.
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      await expect(
        db.asUser(t.ownerUserId, () => db.query(`select revoke_device($1, '')`, [device])),
      ).rejects.toThrow(/VALIDATION_FAILED/);
    });

    it('refuses a caller without devices.manage', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { userId } = await addMember(db, t.tenantId, { roleKey: 'cashier' });

      await expect(
        db.asUser(userId, () => db.query(`select revoke_device($1, 'Trying it on')`, [device])),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('audit trail', () => {
    it('records issuance, activation and revocation', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);
      await activate(code);
      await db.asUser(t.ownerUserId, () =>
        db.query(`select revoke_device($1, 'Decommissioned')`, [device]),
      );

      const { rows } = await db.asServiceRole(() =>
        db.query<{ action: string }>(
          `select action from audit_logs where entity_id = $1 order by occurred_at, action`,
          [device],
        ),
      );
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('DEVICE_ACTIVATION_CODE_ISSUED');
      expect(actions).toContain('DEVICE_ACTIVATED');
      expect(actions).toContain('DEVICE_REVOKED');
    });

    it('never writes a code or secret into the audit log', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);
      const { rows: activation } = await activate(code);
      const secret = activation[0]!.device_secret;

      const { rows } = await db.asServiceRole(() =>
        db.query<{ blob: string }>(`select metadata::text as blob from audit_logs`),
      );
      const everything = rows.map((r) => r.blob).join(' ');

      expect(everything, 'an activation code reached the audit log').not.toContain(code);
      expect(everything, 'a device secret reached the audit log').not.toContain(secret);
      // The last four characters are recorded on purpose, so support can identify a code.
      expect(everything).toContain(code.slice(-4));
    });
  });

  describe('devices_safe view', () => {
    it('omits the credential hash entirely', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);
      const { code } = await issueCode(t.ownerUserId, device);
      await activate(code);

      const { rows } = await db.asUser(t.ownerUserId, () =>
        db.query<Record<string, unknown>>(`select * from devices_safe where id = $1`, [device]),
      );
      expect(Object.keys(rows[0]!)).not.toContain('secret_hash');
    });

    it('derives terminal health', async () => {
      const t = await createTenant(db);
      const device = await createDevice(t.tenantId, t.branchId);

      const pending = await db.asUser(t.ownerUserId, () =>
        db.query<{ health: string }>(`select health from devices_safe where id = $1`, [device]),
      );
      expect(pending.rows[0]!.health).toBe('INACTIVE');

      const { code } = await issueCode(t.ownerUserId, device);
      await activate(code);

      const online = await db.asUser(t.ownerUserId, () =>
        db.query<{ health: string }>(`select health from devices_safe where id = $1`, [device]),
      );
      expect(online.rows[0]!.health).toBe('ONLINE');

      await db.asServiceRole(() =>
        db.query(`update devices set last_seen_at = now() - interval '3 hours' where id = $1`, [
          device,
        ]),
      );
      const offline = await db.asUser(t.ownerUserId, () =>
        db.query<{ health: string }>(`select health from devices_safe where id = $1`, [device]),
      );
      expect(offline.rows[0]!.health).toBe('OFFLINE');
    });

    it('does not leak another tenant’s terminals', async () => {
      const a = await createTenant(db);
      const b = await createTenant(db);
      await createDevice(b.tenantId, b.branchId, 'pos-theirs');

      const { rows } = await db.asUser(a.ownerUserId, () =>
        db.query(`select id from devices_safe`),
      );
      expect(rows).toHaveLength(0);
    });
  });
});
