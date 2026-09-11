'use server';

import { revalidatePath } from 'next/cache';
import { ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { currentAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionFailed, actionOk, toActionResult, type ActionResult } from './errors';

const branchSchema = z.object({
  name: z.string().trim().min(2, 'Give the branch a name.').max(80),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,19}$/, 'Lowercase letters, numbers and hyphens.'),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
});

/**
 * Opens a branch for the signed-in business.
 *
 * The business is taken from the session, never from the form, and `create_branch` checks
 * `branches.manage` and creates the branch's register in the same transaction — a branch
 * without a register could not take a sale.
 */
export async function createBranch(input: unknown): Promise<ActionResult<{ branchId: string }>> {
  try {
    const parsed = branchSchema.parse(input);
    const auth = await currentAuth();
    if (!auth?.tenant) return actionFailed(ErrorCode.UNAUTHENTICATED, 'Sign in first.');

    const client = await supabase();
    const { data, error } = await client.rpc('create_branch', {
      p_tenant_id: auth.tenant.tenantId,
      p_name: parsed.name,
      p_code: parsed.code,
      ...(parsed.address ? { p_address: parsed.address } : {}),
      ...(parsed.phone ? { p_phone: parsed.phone } : {}),
    });
    if (error) throw error;

    revalidatePath('/branches');
    revalidatePath('/dashboard');
    return actionOk({ branchId: data });
  } catch (error) {
    return toActionResult(error);
  }
}
