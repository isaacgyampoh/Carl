/**
 * `@carl/infrastructure` — adapters to the outside world.
 *
 * Implements the ports the application layer declares. This is the only package that knows
 * Supabase exists.
 *
 * Note what is NOT re-exported here: `./supabase/server-client.js` and
 * `./config/server-env.js`. Both import `server-only`, and re-exporting them from the
 * package root would make every importer — including client components — fail to build.
 * Server code imports those paths directly, which also makes a server-only dependency
 * visible at the import site.
 */

export * from './config/public-env.js';
export * from './supabase/browser-client.js';
