'use server';

import { redirect } from 'next/navigation';
import { createLogger, ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { requirePlatformAdmin } from '@/lib/auth';
import { ownerDestination } from '@/lib/destinations';
import { currentSurface, supabase, serviceRoleClient } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'platform-auth' } });

const pinSchema = z.object({
  pin: z.string().regex(/^[0-9]{4}$/),
  // A console screen to return to. Confined to the console by ownerDestination().
  next: z.string().max(300).optional(),
});

/**
 * Signs the platform owner in with a PIN.
 *
 * ## How this stays a real session rather than a bypass
 *
 * The PIN is verified in the database and nowhere else. On success the server mints an
 * ordinary Supabase session for the platform administrator's own account, using the Auth
 * admin API — so what the owner ends up holding is a normal session for a normal user, and
 * every RLS policy and authorization check applies to them exactly as before. A correct
 * PIN opens the door; it does not remove the walls.
 *
 * The service-role key is used here and only here in this flow, server-side, to mint that
 * session. It never reaches the browser.
 *
 * ## Where it leads
 *
 * To the owner console, decided here from the verified result, never to wherever the browser
 * was. It runs only on the owner console's own surface (lib/surface.ts), so the session it
 * mints lands in the owner's cookie and can neither replace nor be replaced by a business
 * sign-in on the same device.
 *
 * ## What is deliberately not logged
 *
 * The PIN, in any form. Not on success, not on failure, not truncated, not hashed. A
 * credential in a log file is a credential in everybody's log aggregator.
 */
export async function signInWithPin(
  input: unknown,
): Promise<ActionResult<{ mustChangePin: boolean; destination: string }>> {
  try {
    const parsed = pinSchema.safeParse(input);
    // Same answer as a wrong PIN: a distinct "malformed" response tells an attacker their
    // probe reached the checker, which is information they do not need. Invoked from any page
    // but the owner's own, it would write the owner's session into a business's cookie, so it
    // refuses there before a PIN is ever checked or an attempt counted.
    if (!parsed.success || (await currentSurface()) !== 'owner') {
      return { ok: false, code: 'INVALID_PIN', message: 'That PIN is not correct.' };
    }

    const admin = serviceRoleClient();

    const { data, error } = await admin.rpc('verify_platform_pin', { p_pin: parsed.data.pin });
    if (error) throw error;

    const result = data?.[0];
    if (result?.status !== 'OK' || !result.user_id || !result.email) {
      if (result?.status === 'LOCKED') {
        log.warn('platform pin locked out');
        return {
          ok: false,
          code: 'PIN_LOCKED',
          message: 'Too many incorrect attempts. Try again shortly.',
        };
      }
      log.warn('platform pin rejected');
      return { ok: false, code: 'INVALID_PIN', message: 'That PIN is not correct.' };
    }

    /*
     * Mint the session.
     *
     * `generateLink` produces a one-time token for this exact account without sending an
     * email; `verifyOtp` on the request-scoped client exchanges it and writes the session
     * cookie. Both halves happen on the server within this call, so the token is never
     * transmitted anywhere.
     */
    /*
     * From here the PIN has ALREADY been verified. Everything below is session plumbing, and
     * it fails for reasons that have nothing to do with the credential — so it reports a
     * distinct code rather than falling into the generic handler, where the console would
     * tell the owner to check their internet connection.
     *
     * The failure that made this necessary: the administrator's Auth account was created by
     * hand and had no `email_confirmed_at`, so GoTrue treated a magic-link request as a fresh
     * signup, tried to INSERT, and hit `users_email_partial_key`. The Auth API answered 500,
     * this threw, and the owner saw "We're having trouble connecting right now."
     */
    try {
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email: result.email,
      });
      if (linkError) throw linkError;

      const tokenHash = link?.properties?.hashed_token;
      if (!tokenHash) throw new Error('Auth returned no one-time token.');

      const client = await supabase();
      const { error: verifyError } = await client.auth.verifyOtp({
        type: 'magiclink',
        token_hash: tokenHash,
      });
      if (verifyError) throw verifyError;
    } catch (sessionError) {
      // Logged in full for whoever is on call; the owner gets a sentence they can act on.
      log.error('platform session could not be created', {
        detail: sessionError instanceof Error ? sessionError.message : String(sessionError),
      });
      return {
        ok: false,
        code: ErrorCode.SESSION_CREATION_FAILED,
        message:
          'Your PIN was accepted, but Carl could not start your session. This is a problem on ' +
          'our side, not with your PIN.',
      };
    }

    log.info('platform owner signed in', { userId: result.user_id });
    const mustChangePin = result.is_default === true;
    return actionOk({
      mustChangePin,
      destination: mustChangePin
        ? '/platform/settings?change_pin=1'
        : ownerDestination(parsed.data.next),
    });
  } catch (error) {
    return toActionResult(error);
  }
}

const changeSchema = z
  .object({
    currentPin: z.string().regex(/^[0-9]{4}$/, 'A PIN is four digits.'),
    newPin: z.string().regex(/^[0-9]{4}$/, 'A PIN is four digits.'),
    confirmPin: z.string(),
  })
  .refine((v) => v.newPin === v.confirmPin, {
    message: 'The two new PINs do not match.',
    path: ['confirmPin'],
  });

/**
 * Changes the owner PIN.
 *
 * The rules — current PIN required, the published default refused, obvious sequences
 * refused — live in the database function, not here. This layer would be the wrong place:
 * a second caller, or a refactor of this file, would quietly drop them.
 */
export async function changeOwnerPin(input: unknown): Promise<ActionResult<{ changed: true }>> {
  try {
    const parsed = changeSchema.parse(input);
    await requirePlatformAdmin();

    const client = await supabase();
    const { error } = await client.rpc('change_platform_pin', {
      p_current_pin: parsed.currentPin,
      p_new_pin: parsed.newPin,
    });
    if (error) throw error;

    log.info('platform owner pin changed');
    return actionOk({ changed: true });
  } catch (error) {
    return toActionResult(error);
  }
}

/** Ends the owner's session, and returns to the owner's PIN at the main address. */
export async function signOutOwner(): Promise<never> {
  const client = await supabase();
  await client.auth.signOut();
  redirect('/');
}
