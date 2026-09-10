import { type NextResponse } from 'next/server';
import { z } from '@carl/validation';

import { serviceRoleClient } from '@/lib/supabase';
import { badRequest, deviceCredential, deviceError, log, ok, pepper } from '../route-support';

/**
 * A cashier signing in at a till.
 *
 * The terminal proves which shop it is with its device secret; the cashier proves who they
 * are with four digits. Both are verified in the database, and only then does this mint a
 * session for that person — so the sale that follows is attributed to them and gated by the
 * permissions they actually hold.
 *
 * The service-role key and the device pepper live here, on the server, and never reach the
 * Windows bundle. That is the reason this route exists rather than the till talking to
 * Supabase directly.
 */
export const dynamic = 'force-dynamic';

const schema = deviceCredential.extend({
  pin: z.string().regex(/^[0-9]{4}$/),
});

export async function POST(request: Request): Promise<NextResponse> {
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      // A malformed PIN gets the same answer as a wrong one: distinguishing them tells a
      // caller their probe reached the checker.
      return badRequest('That PIN is not correct.');
    }
    return badRequest('A JSON body is required.');
  }

  try {
    const admin = serviceRoleClient();
    const { data, error } = await admin.rpc('verify_device_staff_pin', {
      p_device_id: parsed.deviceId,
      p_device_secret: parsed.deviceSecret,
      p_pepper: pepper(),
      p_pin: parsed.pin,
    });
    if (error) throw error;

    const result = data?.[0];

    if (result?.out_status === 'LOCKED') {
      log.warn('till pin locked out', { deviceId: parsed.deviceId });
      return ok({ status: 'LOCKED' });
    }
    if (result?.out_status !== 'OK' || !result.out_email) {
      log.warn('till pin rejected', { deviceId: parsed.deviceId });
      return ok({ status: 'INVALID' });
    }

    /*
     * Mint the cashier's session.
     *
     * `generateLink` produces a one-time token for this account without sending an email;
     * exchanging it here yields the tokens the till stores in the OS credential store. The
     * till never holds anything that could sign in as somebody else.
     */
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: result.out_email,
    });
    if (linkError) throw linkError;

    const tokenHash = link?.properties?.hashed_token;
    if (!tokenHash) throw new Error('Could not establish a session for this cashier.');

    const { data: session, error: verifyError } = await admin.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    });
    if (verifyError) throw verifyError;
    if (!session.session) throw new Error('No session was returned.');

    log.info('cashier signed in at till', {
      deviceId: parsed.deviceId,
      ...(result.out_user_id ? { userId: result.out_user_id } : {}),
    });

    return ok({
      status: 'OK',
      accessToken: session.session.access_token,
      refreshToken: session.session.refresh_token,
      expiresAt: session.session.expires_at,
      mustChangePin: result.out_must_change === true,
      // Narrowed rather than trusted: user_metadata is arbitrary JSON the account owner
      // can shape, so it is not assumed to hold a string.
      cashierName:
        typeof session.user?.user_metadata?.full_name === 'string'
          ? session.user.user_metadata.full_name
          : null,
      tenantName: result.out_tenant_name,
      branchName: result.out_branch_name,
    });
  } catch (error) {
    return deviceError(error, { deviceId: parsed.deviceId, route: 'staff-pin' });
  }
}
