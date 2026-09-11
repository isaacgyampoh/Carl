/**
 * `server-only` for unit tests.
 *
 * The real package throws when imported outside a React Server Component build, which is its
 * whole purpose in the app. Unit tests run the server-side resolution code directly in Node,
 * where there is no such build, so the guard is replaced with nothing here and only here.
 */
export {};
