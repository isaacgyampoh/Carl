/**
 * Keeping the till's catalogue current.
 *
 * ## Why this is separate from the sale queue
 *
 * The two directions have opposite priorities. An unsent sale is irreplaceable and must be
 * retried until it lands. A stale catalogue is merely stale — the terminal goes on selling
 * yesterday's list, which is exactly what it is supposed to do when the connection is down.
 * Mixing them would let a failed catalogue download block a queue of takings, or a queue of
 * takings delay a price change.
 *
 * So this fails quietly. A catalogue that cannot be refreshed is a normal Tuesday in a shop
 * with bad internet.
 *
 * ## The clock
 *
 * Every successful pull carries the server's time, and it is used for two things: the cursor
 * for the next incremental pull, and correcting this machine's clock. A till whose clock is
 * a day out would otherwise stamp offline sales into the wrong day — and the server refuses
 * a sale dated in the future, so a fast clock loses sales outright, after the money is taken.
 */

import type { CatalogueStore, CataloguePayload } from './catalogue-store';
import type { DeviceApi } from './device-api';
import type { DeviceStore } from './device-store';

export interface CatalogueSyncResult {
  readonly ok: boolean;
  readonly productsChanged: number;
  readonly detail?: string;
}

export class CatalogueSync {
  constructor(
    private readonly api: DeviceApi,
    private readonly store: CatalogueStore,
    private readonly devices: DeviceStore,
    private readonly credential: { deviceId: string; deviceSecret: string },
  ) {}

  /**
   * Pulls what has changed and applies it.
   *
   * `full` ignores the local cursor and re-downloads everything — for a terminal whose
   * local catalogue is suspect, and on first run, where there is no cursor at all.
   */
  async run(options: { full?: boolean } = {}): Promise<CatalogueSyncResult> {
    const config = await this.devices.read();
    if (!config) return { ok: false, productsChanged: 0, detail: 'This terminal is not set up.' };

    const result = await this.api.catalogue({
      ...this.credential,
      since: options.full ? null : config.catalogueVersion,
    });

    if (!result.ok) {
      return { ok: false, productsChanged: 0, detail: result.failure.detail };
    }

    const payload = result.value as CataloguePayload;
    await this.store.apply(payload);
    // Only after the catalogue is safely applied: the offset and the cursor are recorded
    // together, so a failed apply cannot leave the terminal believing it is up to date.
    await this.devices.recordClockOffset(payload.server_time);

    return {
      ok: true,
      productsChanged: payload.products.length + payload.removed_products.length,
    };
  }
}
