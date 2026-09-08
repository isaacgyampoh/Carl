/**
 * `@carl/types` — types generated from the database schema.
 *
 * Kept in its own package so the domain layer never accidentally depends on the shape of a
 * database row. Domain models are hand-written; these describe the wire format.
 *
 * Regenerate with `pnpm db:types` after any migration.
 */

export type {
  Database,
  Json,
  Tables,
  Views,
  Enums,
  Row,
  InsertRow,
  UpdateRow,
  ViewRow,
} from './database.generated';
