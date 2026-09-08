/**
 * Supabase clients for server-side use.
 *
 * Two are exported, and the difference between them is the most consequential distinction
 * in Carl's codebase:
 *
 *   serverClient()      acts AS THE USER. Subject to RLS. The default for everything.
 *   serviceRoleClient() BYPASSES RLS ENTIRELY. For a handful of platform operations.
 *
 * `server-only` is imported so that any module reachable from a client component that
 * imports this file fails the build rather than shipping a service-role key to a browser.
 */

import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@carl/types';

import { publicEnv } from '../config/public-env.js';
import { serverEnv } from '../config/server-env.js';

export type CarlSupabaseClient = SupabaseClient<Database>;

/** The cookie operations Next.js supplies; abstracted so this package need not import next. */
export interface CookieStore {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options?: Record<string, unknown>): void;
}

/**
 * A client acting as the signed-in user.
 *
 * Every query it makes is filtered by RLS exactly as the browser's would be. Use this for
 * all ordinary request handling — including in server actions, where it is tempting to
 * reach for the service role because it is "server-side anyway". Server-side is not the
 * same as authorised.
 */
export function serverClient(cookies: CookieStore): CarlSupabaseClient {
  const env = publicEnv();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookies.getAll(),
        setAll: (items) => {
          try {
            for (const { name, value, options } of items) {
              cookies.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. The middleware refreshes the session,
            // so a failure here is expected and harmless rather than an error to surface.
          }
        },
      },
    },
  );
}

/**
 * A client that bypasses Row Level Security completely.
 *
 * Anything holding this can read and write every tenant's data. It exists for the few
 * operations that genuinely cannot run as a user because no authorised user exists yet:
 *
 *   - provisioning a tenant (there is no member to act as)
 *   - activating a device (the terminal has no session)
 *   - background jobs with no request context
 *
 * Everything else uses `serverClient`. Reaching for this to make a permission error go
 * away removes Carl's entire authorization model for that code path.
 */
export function serviceRoleClient(): CarlSupabaseClient {
  const env = publicEnv();
  const secrets = serverEnv();

  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, secrets.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // No session to persist, and no token to refresh: this client is not a user.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      // Makes service-role traffic identifiable in Supabase's logs, so an unexpected
      // bypass is visible rather than indistinguishable from ordinary requests.
      headers: { 'x-carl-client': 'service-role' },
    },
  });
}
