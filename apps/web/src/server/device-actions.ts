'use server';

import { revalidatePath } from 'next/cache';
import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';
import { serverEnv } from '@carl/infrastructure/config/server-env';

import { requireTenant } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'device-actions' } });

const issueSchema = z.object({
  deviceId: z.uuid(),
  validHours: z.number().int().min(1).max(48).default(24),
});

const revokeSchema = z.object({
  deviceId: z.uuid(),
  reason: z.string().trim().min(3).max(200),
});

/**
 * Issues a one-time activation code.
 *
 * The pepper is read here, server-side, and passed to the database function. It never
 * reaches a client and is never stored — that is what keeps a short, typable code
 * resistant to brute force even if the database is dumped.
 *
 * The plaintext code is returned to the caller exactly once. Nothing logs it.
 */
export async function issueActivationCode(
  input: unknown,
): Promise<ActionResult<{ code: string; expiresAt: string }>> {
  try {
    const parsed = issueSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('issue_activation_code', {
      p_device_id: parsed.deviceId,
      p_pepper: serverEnv().CARL_DEVICE_SECRET_PEPPER,
      p_valid_hours: parsed.validHours,
    });
    if (error) throw error;

    const row = data?.[0];
    if (!row?.code) throw new Error('issue_activation_code returned no code');

    // Deliberately logs the device, never the code. The last four characters are recorded
    // in the audit log by the database function, which is enough for support.
    log.info('activation code issued', {
      tenantId: auth.tenant.tenantId,
      deviceId: parsed.deviceId,
      userId: auth.user.userId,
    });

    revalidatePath('/devices');
    return actionOk({ code: row.code, expiresAt: row.expires_at ?? '' });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function revokeDevice(input: unknown): Promise<ActionResult<{ deviceId: string }>> {
  try {
    const parsed = revokeSchema.parse(input);
    const auth = await requireTenant();

    const client = await supabase();
    const { error } = await client.rpc('revoke_device', {
      p_device_id: parsed.deviceId,
      p_reason: parsed.reason,
    });
    if (error) throw error;

    log.warn('device revoked', {
      tenantId: auth.tenant.tenantId,
      deviceId: parsed.deviceId,
      userId: auth.user.userId,
    });

    revalidatePath('/devices');
    return actionOk({ deviceId: parsed.deviceId });
  } catch (error) {
    return toActionResult(error);
  }
}
