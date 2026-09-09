import { type NextResponse } from 'next/server';
import { z } from '@carl/validation';

import { serviceRoleClient } from '@/lib/supabase';
import { badRequest, deviceError, log, ok, pepper } from '../route-support';

/**
 * Activation: a fresh till exchanges a typed code for its long-lived secret.
 *
 * Unauthenticated by design — the code *is* the authentication, and there is no user
 * session on a terminal being installed. Guessing it is not practical: twelve characters
 * from a 32-symbol alphabet is 60 bits, the code expires within 48 hours, and the database
 * caps attempts per code.
 *
 * Service role is used because the caller is nobody yet: no user, no membership, so RLS
 * has nothing to filter by. `activate_device` does the whole check itself.
 */
export const dynamic = 'force-dynamic';

const schema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    // Installers transcribe these by hand from a screen; hyphens and spaces get added.
    .transform((value) => value.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[A-Z2-9]{12}$/, 'An activation code is 12 characters.')),
  /**
   * Stable per installation. It is what makes a retry idempotent: if the response is lost
   * on a bad connection, retrying with the same install id returns a session rather than
   * "code already consumed", which would otherwise strand an installer with an activated
   * till and no secret.
   */
  installId: z.string().trim().min(8).max(200),
  platform: z.enum(['WINDOWS', 'MACOS', 'LINUX', 'ANDROID', 'IOS', 'WEB']).optional(),
  appVersion: z.string().trim().max(40).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch (error) {
    // The code itself is never echoed back, logged, or included in the validation detail.
    if (error instanceof z.ZodError) return badRequest(error.issues.map((i) => i.message));
    return badRequest('A JSON body is required.');
  }

  try {
    const { data, error } = await serviceRoleClient().rpc('activate_device', {
      p_code: parsed.code,
      p_pepper: pepper(),
      p_install_id: parsed.installId,
      ...(parsed.platform ? { p_platform: parsed.platform } : {}),
      ...(parsed.appVersion ? { p_app_version: parsed.appVersion } : {}),
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    // Both are nullable in the generated types because they come from a RETURNS TABLE.
    // A successful activation always fills them, and a response missing either is a broken
    // session rather than something to hand a terminal.
    if (!row?.device_secret || !row.device_id || !row.tenant_id || !row.branch_id) {
      throw new Error('activate_device returned no session');
    }
    const { tenant_id: tenantId, branch_id: branchId } = row;

    // The till shows which business and which branch it belongs to, on screen and on every
    // receipt. A cashier who cannot tell at a glance that a terminal is pointed at the
    // right branch is a cashier who will eventually sell against the wrong stock.
    const [tenant, branch] = await Promise.all([
      serviceRoleClient().from('tenants').select('name').eq('id', tenantId).single(),
      serviceRoleClient().from('branches').select('name').eq('id', branchId).single(),
    ]);

    log.info('device activated', { deviceId: row.device_id, installId: parsed.installId });

    // The only time the secret is ever transmitted. The terminal puts it straight into the
    // OS keychain; it cannot be recovered from the server afterwards.
    return ok({
      deviceId: row.device_id,
      tenantId: row.tenant_id,
      branchId: row.branch_id,
      deviceCode: row.device_code,
      deviceName: row.device_name ?? row.device_code,
      tenantName: tenant.data?.name ?? '',
      branchName: branch.data?.name ?? '',
      deviceSecret: row.device_secret,
      authorizedUntil: row.authorized_until,
    });
  } catch (error) {
    return deviceError(error, { installId: parsed.installId, route: 'activate' });
  }
}
