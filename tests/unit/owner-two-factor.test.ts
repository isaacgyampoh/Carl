import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The owner console's second factor.
 *
 * The console can onboard, suspend and bill every business on Carl, and its front door is a
 * four-digit PIN on a public address. Once an authenticator app is enrolled, the PIN alone must
 * stop opening it — including for a session that already holds the PIN, and including on a
 * screen somebody navigated to directly.
 *
 * Asserted on the source: the enforcement is a guard and a set of server actions, and what
 * matters is that neither can be bypassed by a route that forgot to ask.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, 'apps', 'web', 'src', ...p), 'utf8');

describe('the guard', () => {
  const auth = read('lib', 'auth.ts');

  it('reads the assurance level from Auth, not from a table or a claim the browser sets', () => {
    expect(auth).toContain('client.auth.mfa.getAuthenticatorAssuranceLevel()');
    expect(auth).toContain("required: levels.data?.nextLevel === 'aal2'");
    expect(auth).toContain("satisfied: levels.data?.currentLevel === 'aal2'");
  });

  it('turns back a console session that has the PIN but not the code', () => {
    const guard = auth.slice(auth.indexOf('export async function requirePlatformAdmin'));
    expect(guard).toContain('const mfa = await ownerMfaState();');
    expect(guard).toMatch(/if \(mfa\.required && !mfa\.satisfied\) redirect\('\/'\);/);
  });

  it('keeps the pre-code session usable only where the code is asked for', () => {
    expect(auth).toContain('export async function requireOwnerSession');
    // The entry page and the verification action, and nothing else.
    const users = ['app/page.tsx', 'server/owner-mfa-actions.ts'];
    for (const file of users)
      expect(read(...file.split('/'))).toMatch(/requireOwnerSession|ownerMfaState/);
  });
});

describe('the sign-in step', () => {
  const entry = read('app', 'page.tsx');
  const prompt = read('components', 'owner-totp-prompt.tsx');

  it('asks for the code at the main address, not on a page of its own', () => {
    expect(entry).toContain('const awaitingCode = mfa !== null && mfa.required && !mfa.satisfied;');
    expect(entry).toContain(
      'awaitingCode ? <OwnerTotpPrompt next={next} /> : <OwnerPinPad next={next} />',
    );
    // And the console is only opened when the code is not outstanding.
    expect(entry).toContain(
      'if (auth?.user.isPlatformAdmin && !awaitingCode) redirect(ownerDestination(next));',
    );
  });

  it('sends the browser where the server says, after the server verified the code', () => {
    expect(prompt).toContain('window.location.replace(result.data.destination)');
    expect(prompt).not.toMatch(/router\.(replace|push)\(/);
  });

  it('offers a way out rather than stranding a half-signed-in session', () => {
    expect(prompt).toContain('signOut()');
  });
});

describe('the server actions', () => {
  const actions = read('server', 'owner-mfa-actions.ts');

  it('run only on the owner console, never from a business page', () => {
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual([
      'confirmOwnerTotpEnrollment',
      'disableOwnerTotp',
      'startOwnerTotpEnrollment',
      'verifyOwnerTotp',
    ]);
    // Every one of them refuses elsewhere before it does anything.
    const bodies = exported.map(
      (name) => actions.slice(actions.indexOf(`export async function ${name}`)).split('\n}\n')[0],
    );
    for (const body of bodies)
      expect(body).toContain('if (!(await onOwnerSurface())) return REFUSED;');
    expect(actions).toContain("return (await currentSurface()) === 'owner';");
  });

  it('accepts only a six-digit code, and answers a wrong one neutrally', () => {
    expect(actions).toContain('z.string().regex(/^[0-9]{6}$/)');
    expect(actions).toContain("code: 'INVALID_CODE'");
  });

  it('verifies the code through Auth rather than comparing anything itself', () => {
    expect(actions.match(/client\.auth\.mfa\.challengeAndVerify/g)?.length).toBe(3);
    expect(actions).toContain('client.auth.mfa.enroll(');
    expect(actions).toContain('client.auth.mfa.unenroll(');
  });

  it('will not switch the factor off without a current code', () => {
    const disable = actions.slice(actions.indexOf('export async function disableOwnerTotp'));
    expect(disable.indexOf('challengeAndVerify')).toBeLessThan(disable.indexOf('unenroll'));
    expect(disable).toContain('await requirePlatformAdmin();');
  });

  it('never logs a code or a secret', () => {
    for (const line of actions.split('\n').filter((l) => l.includes('log.'))) {
      expect(line, line.trim()).not.toMatch(/code|secret|qr/i);
    }
  });
});

describe('turning it on', () => {
  it('is offered in the console settings, with the warning that it is off', () => {
    const settings = read('app', '(owner)', 'platform', 'settings', 'page.tsx');
    expect(settings).toContain('<TwoFactorSection enrolled={mfa.enrolled} />');
    const section = read('app', '(owner)', 'platform', 'settings', 'two-factor-section.tsx');
    expect(section).toContain('Your PIN is the only thing protecting this console');
    // The secret is shown while enrolling and never kept anywhere else.
    expect(section).toContain('enrolment.secret');
    expect(section).not.toMatch(/localStorage|sessionStorage/);
  });
});
