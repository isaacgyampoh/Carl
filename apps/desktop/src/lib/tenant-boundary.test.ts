import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteConnection } from '@carl/sync/sqlite/node-sqlite-adapter';

import type { DeviceConfig } from './device-store';
import { TenantBoundary, decideRebinding } from './tenant-boundary';

/**
 * One till, one business: re-activation never mixes two merchants' data.
 *
 * Runs against the actual src-tauri/schema.sql the shipped application creates.
 */
describe('the tenant boundary on a till', () => {
  let connection: NodeSqliteConnection;
  let boundary: TenantBoundary;

  const SCHEMA = readFileSync(
    join(import.meta.dirname, '..', '..', 'src-tauri', 'schema.sql'),
    'utf8',
  );
  const TABLES = [
    'products',
    'product_barcodes',
    'product_prices',
    'stock_levels',
    'customers',
    'sync_queue',
    'local_receipts',
  ];

  /** A row in every business table, filling required columns from the schema itself. */
  async function seedEveryTable(): Promise<void> {
    for (const table of TABLES) {
      const columns = await connection.select<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(`pragma table_info(${table})`);
      const required = columns.filter(
        (c) => c.pk > 0 || (c.notnull === 1 && c.dflt_value === null),
      );
      const values = required.map((c) =>
        /INT|REAL|NUM/i.test(c.type) ? 1 : c.name === 'state' ? 'PENDING' : 'x',
      );
      await connection.execute(
        `insert into ${table} (${required.map((c) => c.name).join(', ')}) values (${required.map(() => '?').join(', ')})`,
        values,
      );
    }
    await connection.execute(
      `insert into device_config (id, device_id, tenant_id, branch_id, device_code, branch_name, tenant_name, activated_at)
       values (1, 'd1', 't1', 'b1', 'pos-1', 'Main', 'Adom Stores', '2026-09-01T08:00:00Z')`,
    );
    await connection.execute(
      `insert into local_settings (key, value) values ('install_id', 'install-1')`,
    );
  }

  const count = async (table: string) =>
    Number((await connection.select<{ n: number }>(`select count(*) as n from ${table}`))[0]!.n);

  beforeEach(async () => {
    connection = new NodeSqliteConnection(':memory:');
    for (const statement of SCHEMA.split(';')) {
      if (statement.trim()) await connection.execute(statement);
    }
    boundary = new TenantBoundary(connection);
  });

  it("wipes every table that holds the previous business's data, and keeps the machine's settings", async () => {
    await seedEveryTable();
    for (const table of [...TABLES, 'device_config']) expect(await count(table), table).toBe(1);

    await boundary.wipeBusinessData();

    for (const table of [...TABLES, 'device_config']) expect(await count(table), table).toBe(0);
    expect(await count('local_settings')).toBe(1);
  });

  it('counts every sale the server has not accepted, whatever state it is in', async () => {
    for (const [id, state] of [
      ['a', 'PENDING'],
      ['b', 'FAILED'],
      ['c', 'CONFLICT'],
      ['d', 'ABANDONED'],
      ['e', 'IN_FLIGHT'],
      ['f', 'SYNCED'],
    ]) {
      await connection.execute(
        `insert into sync_queue (id, operation, payload, state, occurred_at) values (?, 'complete_sale', '{}', ?, '2026-09-01T09:00:00Z')`,
        [id, state],
      );
    }
    expect(await boundary.unsyncedCount()).toBe(5);
  });

  const previous: DeviceConfig = {
    deviceId: 'd1',
    tenantId: 't1',
    branchId: 'b1',
    deviceCode: 'pos-1',
    branchName: 'Main',
    tenantName: 'Adom Stores',
    currencyCode: 'GHS',
    authorizedUntil: null,
    lastSyncAt: null,
    catalogueVersion: null,
    clockOffsetMs: 0,
    activatedAt: '2026-09-01T08:00:00Z',
  };

  it('treats a first activation as nothing to protect', () => {
    expect(decideRebinding(null, { tenantId: 't1', branchId: 'b1', deviceId: 'd1' }, 0)).toEqual({
      kind: 'first',
    });
  });

  it('keeps everything, unsent sales included, when the same terminal re-authorises', () => {
    expect(
      decideRebinding(previous, { tenantId: 't1', branchId: 'b1', deviceId: 'd1' }, 7),
    ).toEqual({ kind: 'same' });
  });

  it('switches cleanly to another business when nothing is waiting to send', () => {
    expect(
      decideRebinding(previous, { tenantId: 't2', branchId: 'b9', deviceId: 'd9' }, 0),
    ).toEqual({ kind: 'switch' });
  });

  it("refuses to join another business while the previous business's sales are unsent", () => {
    expect(
      decideRebinding(previous, { tenantId: 't2', branchId: 'b9', deviceId: 'd9' }, 3),
    ).toEqual({
      kind: 'refuse',
      unsynced: 3,
      previousTenantName: 'Adom Stores',
    });
  });

  it('also refuses a different terminal or branch of the same business while sales are unsent', () => {
    expect(
      decideRebinding(previous, { tenantId: 't1', branchId: 'b2', deviceId: 'd2' }, 1).kind,
    ).toBe('refuse');
  });
});
