import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canSellOffline,
  OFFLINE_LIMITS,
  queueSummary,
} from '../../apps/web/src/lib/offline-policy';
import { searchCatalogue, type CatalogueItem } from '../../apps/web/src/lib/offline-store';

/**
 * Selling on a phone with no connection.
 *
 * The Windows till keeps its sales in a database on a machine that belongs to the shop. A phone
 * keeps them in browser storage, which the browser may clear and a dropped handset takes with it.
 * So this is deliberately bounded, the boundary is told to the cashier rather than discovered,
 * and every held sale carries the key it was rung up with — which is what makes sending it later
 * safe to do twice.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const web = (...p: string[]) => readFileSync(join(ROOT, 'apps', 'web', 'src', ...p), 'utf8');

describe('how long a till may sell offline', () => {
  const now = new Date('2026-09-11T18:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  it('sells when nothing is waiting', () => {
    expect(canSellOffline({ queued: 0, oldestQueuedAt: null }, now).allowed).toBe(true);
  });

  it('sells while within both bounds', () => {
    const verdict = canSellOffline({ queued: 20, oldestQueuedAt: hoursAgo(3) }, now);
    expect(verdict.allowed).toBe(true);
  });

  it('stops when the device is holding too many sales', () => {
    const verdict = canSellOffline(
      { queued: OFFLINE_LIMITS.maxQueuedSales, oldestQueuedAt: hoursAgo(1) },
      now,
    );
    expect(verdict.allowed).toBe(false);
    // It must say why, and what to do: a till that simply refuses is a till nobody can use.
    expect(verdict.reason).toMatch(/Connect to the internet/);
  });

  it('stops when the oldest unsent sale is older than a shift', () => {
    const verdict = canSellOffline(
      { queued: 2, oldestQueuedAt: hoursAgo(OFFLINE_LIMITS.maxHours) },
      now,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/waiting more than/);
  });

  it('is not confused by a time it cannot read', () => {
    expect(canSellOffline({ queued: 1, oldestQueuedAt: 'not a date' }, now).allowed).toBe(true);
  });

  it('says what it is holding, and says nothing when it holds nothing', () => {
    expect(queueSummary({ queued: 0, oldestQueuedAt: null })).toBeNull();
    expect(queueSummary({ queued: 1, oldestQueuedAt: null })).toBe('1 sale waiting to reach Carl');
    expect(queueSummary({ queued: 4, oldestQueuedAt: null })).toBe('4 sales waiting to reach Carl');
  });
});

describe('searching the copy on the device', () => {
  const items: CatalogueItem[] = [
    {
      productId: 'a',
      name: 'Rice 5kg',
      sku: 'RICE5',
      unit: 'bag',
      unitPrice: 9000,
      quantity: 10,
      packSize: 1,
      barcodes: ['501234567890'],
    },
    {
      productId: 'b',
      name: 'Rice 10kg',
      sku: 'RICE10',
      unit: 'bag',
      unitPrice: 17000,
      quantity: 4,
      packSize: 1,
      barcodes: [],
    },
    {
      productId: 'c',
      name: 'Sugar 1kg',
      sku: 'SUG1',
      unit: 'bag',
      unitPrice: 1800,
      quantity: 25,
      packSize: 6,
      barcodes: ['501999000111'],
    },
  ];

  it('finds a scanned barcode exactly, and nothing else', () => {
    expect(searchCatalogue(items, '501234567890').map((i) => i.productId)).toEqual(['a']);
  });

  it('finds a SKU exactly', () => {
    expect(searchCatalogue(items, 'sug1').map((i) => i.productId)).toEqual(['c']);
  });

  it('falls back to matching the name', () => {
    expect(searchCatalogue(items, 'rice').map((i) => i.productId)).toEqual(['a', 'b']);
  });

  it('answers an empty search with nothing', () => {
    expect(searchCatalogue(items, '   ')).toEqual([]);
  });
});

describe('the till', () => {
  const terminal = web('app', '(app)', 'pos', 'pos-terminal.tsx');

  it('holds a sale when Carl cannot be reached, under the key it was rung up with', () => {
    expect(terminal).toContain('if (await hold()) return;');
    expect(terminal).toContain('key: idempotencyKey,');
    // The same key on the way back: a sale that did reach Carl is recognised, not repeated.
    expect(terminal).toContain('idempotencyKey: sale.key,');
  });

  it('refuses to sell offline past the bound, and says why', () => {
    expect(terminal).toContain('const verdict = canSellOffline(queueState);');
    expect(terminal).toContain('setError(verdict.reason');
  });

  it('marks a held sale on the receipt as not yet reaching Carl', () => {
    expect(terminal).toContain('...(pending ? { pendingSync: true } : {})');
  });

  it('sends oldest first, and keeps what the server refuses for a person to see', () => {
    expect(terminal).toContain(
      "await markQueued(sale.key, { state: 'attention', message: result.message });",
    );
    expect(terminal).toContain('need attention');
  });

  it('searches the copy on the device when there is no connection', () => {
    expect(terminal).toContain('searchCatalogue(catalogue.current, term)');
  });
});

describe('what the device is allowed to keep', () => {
  // The code, without its prose: the file's own comment says it keeps no PIN and no session.
  const code = web('lib', 'offline-store.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const store = code;

  it('keeps the catalogue and unsent sales, and no credential of any kind', () => {
    expect(store).toContain('const CATALOGUE');
    expect(store).toContain('const QUEUE');
    for (const forbidden of [
      /\baccess_token\b/i,
      /\brefresh_token\b/i,
      /device_?secret/i,
      /\bpin\b/i,
      /\bpassword\b/i,
      /\bsession\b/i,
    ]) {
      expect(store, `the device store mentions ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('replays through the same server action an online sale uses', () => {
    // Not a second path into the database: the server still resolves price, stock and identity.
    expect(web('app', '(app)', 'pos', 'pos-terminal.tsx')).toContain('await completeSale({');
    expect(store).not.toMatch(/supabase|rpc\(/);
  });
});
