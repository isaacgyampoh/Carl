/**
 * `@carl/domain` — Carl's business rules.
 *
 * This layer is deliberately framework-free: no React, no Next.js, no Supabase SDK, no
 * browser globals. That is enforced by lint rules, not convention. It exists so the rules
 * that decide what a sale costs and who may refund it can be read, tested and reasoned about
 * without standing up a database or a browser.
 */

export * from './access/permissions.js';
export * from './access/roles.js';
