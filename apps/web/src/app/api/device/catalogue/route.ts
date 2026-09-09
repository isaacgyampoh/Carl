import { type NextResponse } from 'next/server';
import { z } from '@carl/validation';

import { serviceRoleClient } from '@/lib/supabase';
import { badRequest, deviceCredential, deviceError, log, ok, pepper } from '../route-support';

/**
 * What a till downloads so it can sell with the connection down.
 *
 * `since` makes it incremental: a terminal that syncs hourly transfers almost nothing.
 * The cursor is the `server_time` from the previous response, never the terminal's own
 * clock — a till whose clock is wrong must not be able to talk itself out of an update.
 */
export const dynamic = 'force-dynamic';

const schema = deviceCredential.extend({
  since: z.iso.datetime().nullish(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) return badRequest(error.issues.map((i) => i.message));
    return badRequest('A JSON body is required.');
  }

  try {
    const { data, error } = await serviceRoleClient().rpc('device_catalogue', {
      p_device_id: parsed.deviceId,
      p_device_secret: parsed.deviceSecret,
      p_pepper: pepper(),
      p_since: parsed.since ?? undefined,
    });
    if (error) throw error;

    log.info('catalogue served', { deviceId: parsed.deviceId, incremental: Boolean(parsed.since) });
    return ok(data);
  } catch (error) {
    return deviceError(error, { deviceId: parsed.deviceId, route: 'catalogue' });
  }
}
