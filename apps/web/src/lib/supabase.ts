import 'server-only';

import { cookies } from 'next/headers';
import {
  serverClient,
  serviceRoleClient,
  type CarlSupabaseClient,
} from '@carl/infrastructure/supabase/server-client';

/**
 * The Supabase client for the current request, acting as the signed-in user.
 *
 * This is the default for everything. Its queries are filtered by Row Level Security
 * exactly as a browser's would be, which is what makes a forgotten permission check in a
 * server action harmless rather than a data leak.
 */
export async function supabase(): Promise<CarlSupabaseClient> {
  const store = await cookies();
  return serverClient({
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    set: (name, value, options) => {
      store.set(name, value, options);
    },
  });
}

/**
 * A client that bypasses Row Level Security.
 *
 * Only for operations that genuinely cannot run as a user because no authorised user
 * exists yet — provisioning a tenant, activating a device. Every call site should be able
 * to say which of those it is.
 */
export { serviceRoleClient };
export type { CarlSupabaseClient };
