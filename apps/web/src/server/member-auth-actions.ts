'use server';

import { createLogger } from '@carl/shared';
import { z } from '@carl/validation';

import { BRANCH_COOKIE, CONTEXT_COOKIE_OPTIONS, TENANT_COOKIE, currentAuth } from '@/lib/auth';
import { DOOR_COOKIE } from '@/lib/shop-door';
import { cookies } from 'next/headers';
import { currentSurface, supabase, serviceRoleClient } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'member-auth' } });

const signInSchema = z.object({
  slug: z.string().trim().min(1).max(60),
  pin: z.string().regex(/^[0-9]{4}$/),
  // Which door was used: the business's own address, or the till app's. Not a role.
  entry: z.enum(['portal', 'pos']).optional(),
});

/**
 * Signs a member of staff in with their shop's URL and their own PIN.
 *
 * The slug names the business; the PIN names the person in it. On success the server mints
 * an ordinary Supabase session for that person's account, so every permission check, RLS
 * policy and audit attribution behaves exactly as it would after any other sign-in. A
 * correct PIN opens the door; it does not remove the walls.
 *
 * The PIN is never logged, in any form.
 *
 * ## Where it leads
 *
 * Through `/{slug}/enter`, which selects this business and sends the person, from their own
 * grants, to the till or the dashboard (lib/destinations.ts). Every PIN used to end at
 * `/dashboard` whoever typed it and wherever, including in the installed till app.
 */
export async function signInWithMemberPin(
  input: unknown,
): Promise<ActionResult<{ mustChangePin: boolean; tenantId: string; destination: string }>> {
  try {
    const parsed = signInSchema.safeParse(input);
    // A business PIN belongs to a business's pages. On the owner's, it would write a member's
    // session into the owner console's cookie, so it is refused there before any check.
    if (!parsed.success || (await currentSurface()) !== 'business') {
      return { ok: false, code: 'INVALID_PIN', message: 'That PIN is not correct.' };
    }

    const admin = serviceRoleClient();
    const { data, error } = await admin.rpc('verify_member_pin', {
      p_tenant_slug: parsed.data.slug,
      p_pin: parsed.data.pin,
    });
    if (error) throw error;

    const result = data?.[0];

    if (result?.out_status === 'LOCKED') {
      log.warn('member pin locked out', { slug: parsed.data.slug });
      return {
        ok: false,
        code: 'PIN_LOCKED',
        message: 'Too many incorrect attempts. Try again shortly.',
      };
    }
    if (result?.out_status === 'SUSPENDED') {
      return {
        ok: false,
        code: 'TENANT_SUSPENDED',
        message: 'This business is suspended. Please contact your Carl provider.',
      };
    }
    if (result?.out_status !== 'OK' || !result.out_user_id || !result.out_email) {
      // Same message whether the PIN was wrong or the business does not exist, so the
      // response cannot be used to find out which shops are on Carl.
      return { ok: false, code: 'INVALID_PIN', message: 'That PIN is not correct.' };
    }

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: result.out_email ?? undefined,
    });
    if (linkError) throw linkError;

    const tokenHash = link?.properties?.hashed_token;
    if (!tokenHash) throw new Error('Could not establish a session.');

    const client = await supabase();
    const { error: verifyError } = await client.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    });
    if (verifyError) throw verifyError;

    /*
     * The business this person just signed in at becomes the session's business.
     *
     * Without this, a session resolved to whichever membership the database returned first,
     * so nothing guaranteed that signing in at one shop's address put you in that shop. Any
     * previously chosen branch belonged to the previous context, so it is cleared.
     */
    const store = await cookies();
    if (result.out_tenant_id)
      store.set(TENANT_COOKIE, result.out_tenant_id, CONTEXT_COOKIE_OPTIONS);
    store.delete(BRANCH_COOKIE);
    // Remembered so a screen on this device whose session has ended returns to this
    // business's PIN door rather than the email sign-in page (lib/shop-door.ts).
    store.set(DOOR_COOKIE, parsed.data.slug.toLowerCase(), CONTEXT_COOKIE_OPTIONS);

    log.info('member signed in', {
      userId: result.out_user_id,
      ...(result.out_tenant_id ? { tenantId: result.out_tenant_id } : {}),
    });
    const tenantId = result.out_tenant_id ?? '';
    const mustChangePin = result.out_must_change === true;
    const slug = encodeURIComponent(parsed.data.slug.toLowerCase());
    const till = parsed.data.entry === 'pos';
    return actionOk({
      mustChangePin,
      tenantId,
      destination: mustChangePin
        ? `/${slug}/new-pin?tenant=${encodeURIComponent(tenantId)}${till ? '&to=pos' : ''}`
        : `/${slug}/enter${till ? '?to=pos' : ''}`,
    });
  } catch (error) {
    return toActionResult(error);
  }
}

const changeSchema = z
  .object({
    tenantId: z.uuid(),
    currentPin: z.string().optional(),
    newPin: z.string().regex(/^[0-9]{4}$/, 'A PIN is four digits.'),
    confirmPin: z.string(),
  })
  .refine((v) => v.newPin === v.confirmPin, {
    message: 'The two PINs do not match.',
    path: ['confirmPin'],
  });

/**
 * Sets the caller's own PIN.
 *
 * Whether the current PIN is required is decided by the database, not here: it is waived
 * only when somebody else issued the credential and the holder was told to replace it.
 * Putting that rule in the browser would let a caller skip it.
 */
export async function changeMyPin(input: unknown): Promise<ActionResult<{ changed: true }>> {
  try {
    const parsed = changeSchema.parse(input);
    const auth = await currentAuth();
    if (!auth) return { ok: false, code: 'UNAUTHENTICATED', message: 'Please sign in again.' };

    const client = await supabase();
    const { error } = await client.rpc('change_my_pin', {
      p_tenant_id: parsed.tenantId,
      p_current_pin: parsed.currentPin ?? '',
      p_new_pin: parsed.newPin,
    });
    if (error) throw error;

    log.info('member pin changed', { userId: auth.user.userId });
    return actionOk({ changed: true });
  } catch (error) {
    return toActionResult(error);
  }
}
