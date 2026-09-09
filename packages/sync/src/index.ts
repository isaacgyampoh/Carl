/**
 * `@carl/sync` — the offline transaction queue and its engine.
 *
 * Storage-agnostic on purpose: Carl Desktop backs it with SQLite and the PWA with
 * IndexedDB, and both run the same code against the same tests. A second implementation
 * of "did this transaction sync" would be a second thing that can be wrong about money.
 */

export * from './ports';
export * from './backoff';
export * from './engine';
export * from './memory-queue';
