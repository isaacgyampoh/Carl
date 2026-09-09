import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteConnection } from '@carl/sync/sqlite/node-sqlite-adapter';

import { DeviceStore } from './device-store';

/**
 * What the terminal knows about itself.
 *
 * Two things here are load-bearing and neither is visible in normal use: the clock
 * correction, which decides which day a sale belongs to, and the offline authorisation
 * window, which is the only thing that eventually stops a stolen till.
 */
describe('DeviceStore', () => {
  let connection: NodeSqliteConnection;
  let store: DeviceStore;

  const SCHEMA = readFileSync(
    join(import.meta.dirname, '..', '..', 'src-tauri', 'schema.sql'),
    'utf8',
  );

  const session = {
    deviceId: 'd1',
    tenantId: 't1',
    branchId: 'b1',
    deviceCode: 'pos-1',
    branchName: 'Main Branch',
    tenantName: 'Adom Stores',
    authorizedUntil: '2026-03-02T09:00:00.000Z',
    lastSyncAt: null,
    catalogueVersion: null,
    activatedAt: '2026-03-01T07:00:00.000Z',
  };

  beforeEach(async () => {
    connection = new NodeSqliteConnection(':memory:');
    for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await connection.execute(statement);
    }
    store = new DeviceStore(connection);
  });

  it('reports no configuration before activation', async () => {
    // First run. An ordinary state, not an error.
    expect(await store.read()).toBeNull();
    expect(await store.isAuthorized()).toBe(false);
  });

  it('round-trips what activation returned', async () => {
    await store.save(session);
    const config = await store.read();
    expect(config).toMatchObject({
      deviceId: 'd1',
      branchName: 'Main Branch',
      tenantName: 'Adom Stores',
    });
  });

  it('never stores the device secret', async () => {
    // The secret belongs in the OS credential store. This file travels with a stolen
    // machine; the keychain does not.
    await store.save(session);
    const [row] = await connection.select<Record<string, unknown>>(
      'select * from device_config where id = 1',
    );
    const columns = Object.keys(row!).join(' ');
    expect(columns).not.toMatch(/secret|password|token/i);
  });

  describe('the clock', () => {
    it('corrects a terminal that is running slow', async () => {
      await store.save(session);
      // The till thinks it is 08:00; the server says 09:00.
      await store.recordClockOffset(
        '2026-03-01T09:00:00.000Z',
        new Date('2026-03-01T08:00:00.000Z'),
      );

      const config = await store.read();
      expect(config?.clockOffsetMs).toBe(60 * 60 * 1000);
    });

    it('stamps a sale with the corrected time, not the machine clock', async () => {
      // Without this, a till a day out would put a Saturday's takings into Monday — and
      // the server rejects a sale stamped in the future, so a fast clock loses the sale
      // outright, after the money was taken.
      await store.save(session);
      await store.recordClockOffset(
        '2026-03-01T09:00:00.000Z',
        new Date('2026-03-01T08:00:00.000Z'),
      );

      const drift = (await store.now()).getTime() - Date.now();
      expect(Math.abs(drift - 60 * 60 * 1000)).toBeLessThan(1_000);
    });

    it('uses the machine clock when it has never synced', async () => {
      await store.save(session);
      const drift = Math.abs((await store.now()).getTime() - Date.now());
      expect(drift).toBeLessThan(1_000);
    });
  });

  describe('the offline authorisation window', () => {
    it('permits trading inside the window', async () => {
      await store.save(session);
      expect(await store.isAuthorized(new Date('2026-03-02T08:59:00.000Z'))).toBe(true);
    });

    it('stops the terminal once the window has passed', async () => {
      // This is what bounds the usefulness of a stolen till: without contact, it stops.
      await store.save(session);
      expect(await store.isAuthorized(new Date('2026-03-02T09:00:01.000Z'))).toBe(false);
    });

    it('extends the window when the server says so', async () => {
      await store.save(session);
      await store.save({ ...session, authorizedUntil: '2026-03-05T09:00:00.000Z' });
      expect(await store.isAuthorized(new Date('2026-03-04T00:00:00.000Z'))).toBe(true);
    });

    it('refuses to trade after the terminal is reset', async () => {
      await store.save(session);
      await store.clear();
      expect(await store.isAuthorized()).toBe(false);
    });
  });
});
