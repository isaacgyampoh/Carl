/**
 * `@carl/database` — the contract between Carl and PostgreSQL.
 *
 * Holds the names of the database functions Carl invokes and the translation of PostgreSQL
 * failures into Carl's error vocabulary. Contains no connection logic: opening connections is
 * infrastructure's job.
 */

export * from './rpc';
export * from './errors';
