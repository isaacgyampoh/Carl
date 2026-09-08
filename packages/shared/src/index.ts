/**
 * `@carl/shared` — primitives every layer may depend on.
 *
 * This package has no dependencies, imports no framework, and performs no I/O. It is the one
 * package the domain layer is permitted to import.
 */

export * from './result.js';
export * from './encoding.js';
export * from './errors.js';
export * from './money.js';
export * from './quantity.js';
export * from './ids.js';
export * from './clock.js';
export * from './pagination.js';
export * from './idempotency.js';
export * from './logger.js';
