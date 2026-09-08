/**
 * `@carl/shared` — primitives every layer may depend on.
 *
 * This package has no dependencies, imports no framework, and performs no I/O. It is the one
 * package the domain layer is permitted to import.
 */

export * from './result';
export * from './encoding';
export * from './errors';
export * from './money';
export * from './quantity';
export * from './ids';
export * from './clock';
export * from './pagination';
export * from './idempotency';
export * from './logger';
