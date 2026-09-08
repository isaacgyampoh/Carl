/**
 * `@carl/types` — types generated from the database schema.
 *
 * Kept in its own package so that the domain layer never accidentally depends on the shape of
 * a database row. Domain models are hand-written; these describe the wire format.
 */

export type { Database, Json } from './database.generated.js';
