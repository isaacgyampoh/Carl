/**
 * The Supabase client used in the browser.
 *
 * Authenticates as the signed-in user and carries the anon key, so every query it makes is
 * subject to Row Level Security. That is the entire safety model for this client: it is
 * assumed to be in hostile hands, because a browser always is.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@carl/types';

import { publicEnv } from '../config/public-env.js';

export type CarlSupabaseClient = SupabaseClient<Database>;

let client: CarlSupabaseClient | undefined;

/**
 * Returns the browser client, creating it once.
 *
 * A single instance matters: each client opens its own auth listener and token-refresh
 * timer, so creating one per component leaks both and can produce competing refreshes that
 * invalidate each other's tokens.
 */
export function browserClient(): CarlSupabaseClient {
  if (!client) {
    const env = publicEnv();
    client = createBrowserClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  }
  return client;
}
