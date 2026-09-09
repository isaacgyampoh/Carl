/**
 * The terminal's own record of what it is.
 *
 * Exactly one row, written at activation. Note what is *not* here: the device secret. That
 * is in the OS credential store — a file the user can read is not where a credential
 * belongs, and this database file travels with a stolen machine.
 */

import type { SqliteConnection } from '@carl/sync';

export interface DeviceConfig {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly deviceCode: string;
  readonly branchName: string;
  readonly tenantName: string;
  readonly currencyCode: string;
  readonly authorizedUntil: string | null;
  readonly lastSyncAt: string | null;
  readonly catalogueVersion: string | null;
  readonly clockOffsetMs: number;
  readonly activatedAt: string;
}

interface ConfigRow {
  device_id: string;
  tenant_id: string;
  branch_id: string;
  device_code: string;
  branch_name: string;
  tenant_name: string;
  currency_code: string;
  authorized_until: string | null;
  last_sync_at: string | null;
  catalogue_version: string | null;
  clock_offset_ms: number;
  activated_at: string;
}

export class DeviceStore {
  constructor(private readonly db: SqliteConnection) {}

  async read(): Promise<DeviceConfig | null> {
    const rows = await this.db.select<ConfigRow>('select * from device_config where id = 1');
    const row = rows[0];
    if (!row) return null;
    return {
      deviceId: row.device_id,
      tenantId: row.tenant_id,
      branchId: row.branch_id,
      deviceCode: row.device_code,
      branchName: row.branch_name,
      tenantName: row.tenant_name,
      currencyCode: row.currency_code,
      authorizedUntil: row.authorized_until,
      lastSyncAt: row.last_sync_at,
      catalogueVersion: row.catalogue_version,
      clockOffsetMs: row.clock_offset_ms,
      activatedAt: row.activated_at,
    };
  }

  /** Written once, when activation succeeds. */
  async save(config: Omit<DeviceConfig, 'clockOffsetMs' | 'currencyCode'>): Promise<void> {
    await this.db.execute(
      `insert into device_config
         (id, device_id, tenant_id, branch_id, device_code, branch_name, tenant_name,
          authorized_until, last_sync_at, catalogue_version, activated_at)
       values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
         device_id = excluded.device_id, tenant_id = excluded.tenant_id,
         branch_id = excluded.branch_id, device_code = excluded.device_code,
         branch_name = excluded.branch_name, tenant_name = excluded.tenant_name,
         authorized_until = excluded.authorized_until`,
      [
        config.deviceId,
        config.tenantId,
        config.branchId,
        config.deviceCode,
        config.branchName,
        config.tenantName,
        config.authorizedUntil,
        config.lastSyncAt,
        config.catalogueVersion,
        config.activatedAt,
      ],
    );
  }

  /**
   * Records how far this machine's clock is from the server's.
   *
   * An offline sale is stamped with the corrected time. A till whose clock is a day out
   * would otherwise put a Saturday's takings into Monday, and the shop would reconcile
   * against a day that never happened.
   */
  async recordClockOffset(serverTime: string, localTime = new Date()): Promise<number> {
    const offset = new Date(serverTime).getTime() - localTime.getTime();
    await this.db.execute(
      'update device_config set clock_offset_ms = ?, last_sync_at = ? where id = 1',
      [offset, serverTime],
    );
    return offset;
  }

  /**
   * The time to stamp a sale with: this machine's clock, corrected.
   *
   * The server rejects a sale stamped in the future, so a terminal that has drifted ahead
   * would otherwise have its sales refused on arrival — after the money was taken.
   */
  async now(): Promise<Date> {
    const config = await this.read();
    return new Date(Date.now() + (config?.clockOffsetMs ?? 0));
  }

  /**
   * Whether this terminal is still permitted to trade offline.
   *
   * The window is set by the server at each sync. It is what bounds the usefulness of a
   * stolen till: without contact, it stops.
   */
  async isAuthorized(at = new Date()): Promise<boolean> {
    const config = await this.read();
    if (!config) return false;
    if (!config.authorizedUntil) return true;
    return new Date(config.authorizedUntil).getTime() > at.getTime();
  }

  async clear(): Promise<void> {
    await this.db.execute('delete from device_config where id = 1');
  }
}
