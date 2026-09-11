'use server';

import { createLogger, ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { ownerMfaState, requireOwnerSession, requirePlatformAdmin } from '@/lib/auth';
import { ownerDestination } from '@/lib/destinations';
import { currentSurface, supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const log = createLogger({ level: 'info', base: { module: 'owner-mfa' } });

const codeSchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) });

/** The same neutral answer for a wrong code, a wrong surface and a malformed request. */
const REFUSED = {
  ok: false as const,
  code: 'INVALID_CODE',
  message: 'That code is not correct. Check the app and try the next one.',
};

/** Nothing here runs anywhere but the owner console's own pages. */
async function onOwnerSurface(): Promise<boolean> {
  return (await currentSurface()) === 'owner';
}

/**
 * Starts adding an authenticator app.
 *
 * Returns the QR code and the secret exactly once, to be shown and then forgotten: Supabase
 * keeps the factor unverified until a code from the app proves it was stored, so an abandoned
 * enrolment leaves nothing behind that could be used to sign in.
 *
 * Neither the secret nor any code is ever logged.
 */
export async function startOwnerTotpEnrollment(): Promise<
  ActionResult<{ factorId: string; qrCode: string; secret: string }>
> {
  try {
    if (!(await onOwnerSurface())) return REFUSED;
    await requirePlatformAdmin();

    const state = await ownerMfaState();
    if (state.enrolled) {
      return {
        ok: false,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Two-step verification is already on for this account.',
      };
    }

    const client = await supabase();
    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `Carl owner console ${new Date().toISOString().slice(0, 10)}`,
    });
    if (error || !data) throw error ?? new Error('Auth returned no factor.');

    log.info('owner second factor enrolment started');
    return actionOk({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
  } catch (error) {
    return toActionResult(error);
  }
}

const confirmSchema = codeSchema.extend({ factorId: z.uuid() });

/** Confirms the authenticator app, which turns the factor on and raises this session to it. */
export async function confirmOwnerTotpEnrollment(
  input: unknown,
): Promise<ActionResult<{ enabled: true }>> {
  try {
    if (!(await onOwnerSurface())) return REFUSED;
    const parsed = confirmSchema.safeParse(input);
    if (!parsed.success) return REFUSED;
    await requirePlatformAdmin();

    const client = await supabase();
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId: parsed.data.factorId,
      code: parsed.data.code,
    });
    if (error) {
      log.warn('owner second factor confirmation rejected');
      return REFUSED;
    }

    log.info('owner second factor enabled');
    return actionOk({ enabled: true });
  } catch (error) {
    return toActionResult(error);
  }
}

/**
 * The code asked for after the PIN.
 *
 * Runs on a session that has the PIN but not yet the factor, so it uses the session guard
 * rather than the console guard — the console guard is what sends people here.
 */
const verifySchema = codeSchema.extend({ next: z.string().max(300).optional() });

export async function verifyOwnerTotp(
  input: unknown,
): Promise<ActionResult<{ destination: string }>> {
  try {
    if (!(await onOwnerSurface())) return REFUSED;
    const parsed = verifySchema.safeParse(input);
    if (!parsed.success) return REFUSED;
    await requireOwnerSession();

    const state = await ownerMfaState();
    if (!state.factorId) {
      return {
        ok: false,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'No authenticator app is set up.',
      };
    }

    const client = await supabase();
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId: state.factorId,
      code: parsed.data.code,
    });
    if (error) {
      // Logged as a fact, never with the code.
      log.warn('owner second factor rejected');
      return REFUSED;
    }

    log.info('owner signed in with a second factor');
    return actionOk({ destination: ownerDestination(parsed.data.next) });
  } catch (error) {
    return toActionResult(error);
  }
}

/**
 * Turns the second factor off.
 *
 * Requires a current code even though the session already passed one: switching it off is the
 * one action that makes the PIN sufficient again, and a console left open on a counter should
 * not be enough to do it.
 */
export async function disableOwnerTotp(input: unknown): Promise<ActionResult<{ disabled: true }>> {
  try {
    if (!(await onOwnerSurface())) return REFUSED;
    const parsed = codeSchema.safeParse(input);
    if (!parsed.success) return REFUSED;
    await requirePlatformAdmin();

    const state = await ownerMfaState();
    if (!state.factorId) return actionOk({ disabled: true });

    const client = await supabase();
    const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
      factorId: state.factorId,
      code: parsed.data.code,
    });
    if (verifyError) return REFUSED;

    const { error } = await client.auth.mfa.unenroll({ factorId: state.factorId });
    if (error) throw error;

    log.warn('owner second factor disabled');
    return actionOk({ disabled: true });
  } catch (error) {
    return toActionResult(error);
  }
}
