'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { hasPermission, type AuthContext } from '@carl/application';
import { Permission } from '@carl/domain';
import { createLogger, ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { currentAuth } from '@/lib/auth';
import { serviceRoleClient, supabase } from '@/lib/supabase';
import { actionFailed, actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'staff' } });

const pin = z.string().regex(/^[0-9]{4}$/, 'A PIN is four digits.');

/**
 * The database's own refusals, passed through with their explanation.
 *
 * `PIN_TAKEN` is not a general error code, so the generic mapper would hide the one sentence
 * a manager needs: somebody already uses that PIN, choose another.
 */
function refusal(error: unknown): ActionResult<never> | null {
  const e = error as { message?: string; details?: string } | null;
  if (e?.message === 'PIN_TAKEN') {
    return actionFailed(
      'PIN_TAKEN',
      e.details ?? 'Somebody in this business already uses that PIN.',
    );
  }
  return null;
}

type ManagerContext =
  | {
      readonly ok: true;
      readonly auth: AuthContext;
      readonly tenant: NonNullable<AuthContext['tenant']>;
    }
  | { readonly ok: false; readonly failure: ActionResult<never> };

/** The signed-in caller and the business they are working in, or why there is none. */
async function managerContext(): Promise<ManagerContext> {
  const auth = await currentAuth();
  if (!auth?.tenant) {
    return { ok: false, failure: actionFailed(ErrorCode.UNAUTHENTICATED, 'Sign in first.') };
  }
  return { ok: true, auth, tenant: auth.tenant };
}

const createSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Give the staff member a name.').max(120),
    jobTitle: z.string().trim().max(80).optional(),
    roleKey: z.string().trim().min(1, 'Choose a role.').max(60),
    branchIds: z.array(z.uuid()).max(100).default([]),
    pin,
    confirmPin: z.string(),
  })
  .refine((v) => v.pin === v.confirmPin, {
    message: 'The two PINs do not match.',
    path: ['confirmPin'],
  });

/**
 * Adds a member of staff.
 *
 * ## Why an Auth account is created first
 *
 * Staff sign in with a PIN at their business's address, and the server mints an ordinary
 * Supabase session for them — so each needs a real account. It is created through the Auth
 * admin API, never by inserting into `auth.users`, because a hand-made row is exactly what
 * broke the platform owner's sign-in before.
 *
 * Most cashiers have no email and none is needed, so the account gets a reserved address
 * under `.invalid`, a top-level domain guaranteed never to route.
 *
 * ## Compensation, not atomicity
 *
 * Creating the account and adding the membership cannot share a transaction: one is an Auth
 * API call, the other PostgreSQL. So if the database refuses — a PIN already in use, a role
 * the manager may not grant — the account is deleted again. Nothing half-created survives.
 */
export async function createStaffMember(
  input: unknown,
): Promise<ActionResult<{ membershipId: string }>> {
  const admin = serviceRoleClient();
  let orphanUserId: string | undefined;

  try {
    const parsed = createSchema.parse(input);
    const context = await managerContext();
    if (!context.ok) return context.failure;
    const { auth, tenant } = context;

    // A convenience only: the database refuses regardless.
    if (
      !hasPermission(auth, Permission.STAFF_MANAGE) ||
      !hasPermission(auth, Permission.ROLES_MANAGE)
    ) {
      return actionFailed(ErrorCode.PERMISSION_DENIED, 'You do not have permission to add staff.');
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: `staff-${randomUUID()}@staff.carl.invalid`,
      email_confirm: true,
      // A password nobody knows. Staff sign in with their PIN; this only satisfies the API.
      password: randomUUID() + randomUUID(),
      user_metadata: { full_name: parsed.fullName },
    });
    if (createError || !created.user) {
      throw createError ?? new Error('The staff account could not be created.');
    }
    orphanUserId = created.user.id;

    const client = await supabase();
    const { data, error } = await client.rpc('add_staff_member', {
      p_tenant_id: tenant.tenantId,
      p_user_id: created.user.id,
      p_full_name: parsed.fullName,
      p_role_key: parsed.roleKey,
      p_pin: parsed.pin,
      ...(parsed.branchIds.length > 0 ? { p_branch_ids: parsed.branchIds } : {}),
      ...(parsed.jobTitle ? { p_job_title: parsed.jobTitle } : {}),
    });
    if (error) throw error;

    // The account now belongs to a membership and must not be deleted.
    orphanUserId = undefined;
    log.info('staff member added', {
      tenantId: tenant.tenantId,
      actorId: auth.user.userId,
      role: parsed.roleKey,
    });
    revalidatePath('/staff');
    return actionOk({ membershipId: data });
  } catch (error) {
    if (orphanUserId) await admin.auth.admin.deleteUser(orphanUserId).catch(() => undefined);
    return refusal(error) ?? toActionResult(error);
  }
}

const resetPinSchema = z
  .object({ membershipId: z.uuid(), pin, confirmPin: z.string() })
  .refine((v) => v.pin === v.confirmPin, {
    message: 'The two PINs do not match.',
    path: ['confirmPin'],
  });

/** Issues a new PIN. The holder is asked to choose their own at next sign-in. */
export async function resetStaffPin(
  input: unknown,
): Promise<ActionResult<{ membershipId: string }>> {
  try {
    const parsed = resetPinSchema.parse(input);
    const context = await managerContext();
    if (!context.ok) return context.failure;
    const client = await supabase();
    const { error } = await client.rpc('set_member_pin', {
      p_membership_id: parsed.membershipId,
      p_pin: parsed.pin,
    });
    if (error) throw error;
    revalidatePath('/staff');
    return actionOk({ membershipId: parsed.membershipId });
  } catch (error) {
    return refusal(error) ?? toActionResult(error);
  }
}

const roleSchema = z.object({ membershipId: z.uuid(), roleKey: z.string().trim().min(1).max(60) });

export async function setStaffRole(
  input: unknown,
): Promise<ActionResult<{ membershipId: string }>> {
  try {
    const parsed = roleSchema.parse(input);
    const context = await managerContext();
    if (!context.ok) return context.failure;
    const client = await supabase();
    const { error } = await client.rpc('set_staff_role', {
      p_membership_id: parsed.membershipId,
      p_role_key: parsed.roleKey,
    });
    if (error) throw error;
    revalidatePath('/staff');
    return actionOk({ membershipId: parsed.membershipId });
  } catch (error) {
    return toActionResult(error);
  }
}

const branchesSchema = z.object({
  membershipId: z.uuid(),
  // Empty means every branch — the existing rule in app.can_access_branch().
  branchIds: z.array(z.uuid()).max(100),
});

export async function setStaffBranches(
  input: unknown,
): Promise<ActionResult<{ membershipId: string }>> {
  try {
    const parsed = branchesSchema.parse(input);
    const context = await managerContext();
    if (!context.ok) return context.failure;
    const client = await supabase();
    const { error } = await client.rpc('set_staff_branches', {
      p_membership_id: parsed.membershipId,
      p_branch_ids: parsed.branchIds,
    });
    if (error) throw error;
    revalidatePath('/staff');
    return actionOk({ membershipId: parsed.membershipId });
  } catch (error) {
    return toActionResult(error);
  }
}

const statusSchema = z.object({
  membershipId: z.uuid(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']),
});

/** Suspends, reactivates or removes a member of staff. Suspended staff cannot sign in. */
export async function setStaffStatus(
  input: unknown,
): Promise<ActionResult<{ membershipId: string }>> {
  try {
    const parsed = statusSchema.parse(input);
    const context = await managerContext();
    if (!context.ok) return context.failure;
    const client = await supabase();
    const { error } = await client.rpc('set_staff_status', {
      p_membership_id: parsed.membershipId,
      p_status: parsed.status,
    });
    if (error) throw error;
    revalidatePath('/staff');
    return actionOk({ membershipId: parsed.membershipId });
  } catch (error) {
    return toActionResult(error);
  }
}
