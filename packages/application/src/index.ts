/**
 * `@carl/application` — use cases and the ports they depend on.
 *
 * Orchestrates domain rules and declares the interfaces infrastructure must satisfy. It knows
 * nothing about Supabase, HTTP or React, so a use case can be tested by supplying a fake port
 * rather than a database.
 */

export * from './ports/auth-context.js';
