import 'server-only';

import type { Instrumentation } from 'next';

/** Next.js requires this export; the hook below is the whole point of the file. */
export function register(): void {
  return;
}

/**
 * Every unhandled server error, recorded where the owner can see it.
 *
 * Until this existed, a failure in production told nobody: the shop saw a broken screen, the
 * platform's logs held the detail, and the owner found out when somebody phoned. Errors land in
 * `app_errors`, which the console shows and the scheduled health check counts.
 *
 * ## What is deliberately not recorded
 *
 * The stack, the request body, headers and the query string. A stack on a screen is how
 * internal detail reaches a shopkeeper, and an error store holding request payloads becomes a
 * copy of the data it was meant to protect. The message is truncated; the digest is enough to
 * match a row against the platform's own logs.
 *
 * Recording is best effort and silent: a failure here must never become a second failure on a
 * request that has already gone wrong.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request) => {
  // Only the Node.js runtime has the service-role client; the edge runtime has no business
  // holding it.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { serviceRoleClient } = await import('@/lib/supabase');
    const detail = error as { message?: unknown; digest?: unknown };
    const message =
      typeof detail.message === 'string' && detail.message.length > 0
        ? detail.message
        : String(error);
    const surface = request.headers?.['x-carl-surface'];

    await serviceRoleClient()
      .from('app_errors')
      .insert({
        message: message.slice(0, 2000),
        digest: typeof detail.digest === 'string' ? detail.digest : null,
        // The path only: a query string carries search terms, ids and sometimes a token.
        route: (request.path ?? '').split('?')[0]?.slice(0, 500) ?? null,
        method: request.method ?? null,
        surface: typeof surface === 'string' ? surface.slice(0, 20) : null,
      });
  } catch {
    // Silent by design. The platform's own logs still have the error.
  }
};
