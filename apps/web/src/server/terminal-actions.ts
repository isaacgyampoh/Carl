'use server';

import { revalidatePath } from 'next/cache';
import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';
import { serverEnv } from '@carl/infrastructure/config/server-env';

import { requireTenant } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'terminal-actions' } });

const registerSchema = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(2, 'Give the till a name.').max(60),
});

/**
 * Adds a Windows till to the business and returns its one-time activation code.
 *
 * The business is never taken from the request. `register_device` derives it from the
 * branch and checks the caller may manage terminals there; the code it then issues can only
 * ever activate that terminal, in that business. The plaintext code is returned once and is
 * never logged.
 */
export async function registerTerminal(
  input: unknown,
): Promise<
  ActionResult<{ deviceId: string; deviceCode: string; code: string; expiresAt: string }>
> {
  try {
    const parsed = registerSchema.parse(input);
    const auth = await requireTenant();
    const client = await supabase();

    const { data: registered, error } = await client.rpc('register_device', {
      p_branch_id: parsed.branchId,
      p_name: parsed.name,
    });
    if (error) throw error;
    const device = registered?.[0];
    if (!device?.device_id || !device.device_code)
      throw new Error('register_device returned no terminal');

    const { data: issued, error: issueError } = await client.rpc('issue_activation_code', {
      p_device_id: device.device_id,
      p_pepper: serverEnv().CARL_DEVICE_SECRET_PEPPER,
      p_valid_hours: 24,
    });
    if (issueError) throw issueError;
    const code = issued?.[0];
    if (!code?.code) throw new Error('issue_activation_code returned no code');

    log.info('terminal registered', {
      tenantId: auth.tenant.tenantId,
      deviceId: device.device_id,
      userId: auth.user.userId,
    });

    revalidatePath('/windows-pos');
    revalidatePath('/devices');
    return actionOk({
      deviceId: device.device_id,
      deviceCode: device.device_code,
      code: code.code,
      expiresAt: code.expires_at ?? '',
    });
  } catch (error) {
    return toActionResult(error);
  }
}
