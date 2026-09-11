/**
 * What the till keeps on the device: the catalogue it can sell from, and the sales it has not
 * managed to send yet.
 *
 * IndexedDB rather than localStorage: a shift of sales and a shop's whole catalogue are more
 * than localStorage should hold, and IndexedDB survives a reload without being parsed and
 * re-serialised on every write.
 *
 * ## What is NOT kept here
 *
 * Anything that would let this device act as somebody else. No session, no device secret, no PIN.
 * A queued sale is replayed through the same server action an online sale uses, as the cashier
 * who is signed in, and the server decides everything about it — including its price and whether
 * there was stock. What the device holds is a record of what was rung up, not an authority.
 */
import type { ReceiptSource } from './receipt-data';

const DATABASE = 'carl-till';
const VERSION = 1;
const CATALOGUE = 'catalogue';
const QUEUE = 'queue';

export interface CatalogueItem {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  unitPrice: number;
  quantity: number;
  packSize: number;
  barcodes: string[];
}

export interface QueuedSale {
  /** The sale's identity, reused on every attempt so it can never be recorded twice. */
  key: string;
  branchId: string;
  soldAt: string;
  /** Exactly what the online path sends, minus the key, so replay is not a second code path. */
  payload: Record<string, unknown>;
  /** What the till showed the customer, for the receipt and for comparison after it syncs. */
  total: number;
  receipt: ReceiptSource;
  state: 'waiting' | 'attention';
  message?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CATALOGUE)) db.createObjectStore(CATALOGUE);
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the till store did not open'));
  });
}

/*
 * One transaction, one request, one promise. The result is typed by the caller: IndexedDB's own
 * types say `any`, and the shapes stored here are the ones written by the functions below.
 */
async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  act: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('the till store refused'));
    });
  } finally {
    db.close();
  }
}

export async function saveCatalogue(branchId: string, items: CatalogueItem[]): Promise<void> {
  await run(CATALOGUE, 'readwrite', (store) =>
    store.put({ items, savedAt: new Date().toISOString() }, branchId),
  );
}

export async function loadCatalogue(
  branchId: string,
): Promise<{ items: CatalogueItem[]; savedAt: string } | null> {
  const found = await run<{ items: CatalogueItem[]; savedAt: string } | undefined>(
    CATALOGUE,
    'readonly',
    (store) => store.get(branchId),
  );
  return found ?? null;
}

export async function queueSale(sale: QueuedSale): Promise<void> {
  await run(QUEUE, 'readwrite', (store) => store.put(sale));
}

export async function listQueue(): Promise<QueuedSale[]> {
  const all = await run<QueuedSale[]>(QUEUE, 'readonly', (store) => store.getAll());
  return [...all].sort((a, b) => a.soldAt.localeCompare(b.soldAt));
}

export async function removeQueued(key: string): Promise<void> {
  await run(QUEUE, 'readwrite', (store) => store.delete(key));
}

export async function markQueued(key: string, patch: Partial<QueuedSale>): Promise<void> {
  const current = await run<QueuedSale | undefined>(QUEUE, 'readonly', (store) => store.get(key));
  if (!current) return;
  await run(QUEUE, 'readwrite', (store) => store.put({ ...current, ...patch }));
}

/** Whether this browser can hold anything at all: a private window may refuse. */
export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Searches the cached catalogue the way the server's search does, for when there is no server. */
export function searchCatalogue(
  items: CatalogueItem[],
  query: string,
  limit = 20,
): CatalogueItem[] {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return [];
  const exact = items.filter(
    (item) =>
      item.sku.toLowerCase() === term || item.barcodes.some((code) => code.toLowerCase() === term),
  );
  if (exact.length > 0) return exact.slice(0, limit);
  return items
    .filter(
      (item) => item.name.toLowerCase().includes(term) || item.sku.toLowerCase().includes(term),
    )
    .slice(0, limit);
}
