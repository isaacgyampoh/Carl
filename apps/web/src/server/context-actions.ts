'use server';

import { cookies } from 'next/headers';
import { z } from '@carl/validation';

import { BRANCH_COOKIE, CONTEXT_COOKIE_OPTIONS, currentAuth } from '@/lib/auth';
import { actionFailed, actionOk, type ActionResult } from './errors';

const selectBranchSchema = z.object({ branchId: z.uuid() });

/**
 * Chooses the branch this session operates in.
 *
 * The branch switcher used to write `?branch=` into the URL, which nothing on the server
 * read — so a business with two branches always saw its first. This records the choice
 * server-side instead.
 *
 * Only a branch the caller can already reach is accepted, and `currentAuth` re-checks it on
 * every request anyway, so this is a preference, not a grant.
 */
export async function selectBranch(input: unknown): Promise<ActionResult<{ branchId: string }>> {
  const parsed = selectBranchSchema.safeParse(input);
  if (!parsed.success) return actionFailed('VALIDATION_FAILED', 'That branch is not valid.');

  const auth = await currentAuth();
  const reachable = auth?.tenant?.branches.some((b) => b.id === parsed.data.branchId);
  if (!reachable)
    return actionFailed('PERMISSION_DENIED', 'You do not have access to that branch.');

  const store = await cookies();
  store.set(BRANCH_COOKIE, parsed.data.branchId, CONTEXT_COOKIE_OPTIONS);
  return actionOk({ branchId: parsed.data.branchId });
}
