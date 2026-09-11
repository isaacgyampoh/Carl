import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthContext } from '../../packages/application/src/ports/auth-context';

import {
  businessDestination,
  entryFrom,
  ownerDestination,
} from '../../apps/web/src/lib/destinations';

/**
 * Where each kind of person goes once signed in, decided on the server.
 *
 * The regression: every business PIN ended at /dashboard, whoever typed it and wherever,
 * including in the installed till app, and an emailed link ended at `/`, which is now the
 * owner's entry. The owner console was one redirect away from a business screen at every turn.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, 'apps', 'web', 'src', ...p), 'utf8');

function person(permissions: string[] | null, isPlatformAdmin = false): AuthContext {
  return {
    user: { userId: 'u', email: 'e@example.test', fullName: 'Person', isPlatformAdmin },
    tenant:
      permissions === null
        ? null
        : {
            tenantId: 't',
            tenantName: 'Business',
            status: 'ACTIVE',
            branches: [],
            activeBranchId: null,
            permissions: new Set(permissions),
          },
    deviceId: null,
    requestId: 'r',
  } as unknown as AuthContext;
}

const cashier = person(['sales.create', 'sales.view']);
const administrator = person(['reports.view', 'sales.create', 'sales.view_all', 'staff.manage']);
const stockKeeper = person(['inventory.view', 'inventory.adjust']);

describe('a business sign-in', () => {
  it.each([
    ['a cashier at the till app', cashier, 'pos', '/pos'],
    ['a cashier at the business address', cashier, 'portal', '/pos'],
    ["the business's administrator at the business address", administrator, 'portal', '/dashboard'],
    // The till app is a till, for whoever opens it.
    ["the business's administrator at the till app", administrator, 'pos', '/pos'],
    ['a stock keeper at the business address', stockKeeper, 'portal', '/dashboard'],
    ['a stock keeper, who may not sell, at the till app', stockKeeper, 'pos', '/no-access'],
  ] as const)('%s goes to %s', (_who, auth, entry, destination) => {
    expect(businessDestination(auth, entry)).toBe(destination);
  });

  it('never leads to the owner console, whoever the person is', () => {
    const owner = person(null, true);
    for (const entry of ['portal', 'pos'] as const) {
      expect(businessDestination(owner, entry)).toBe('/no-access');
      expect(businessDestination(null, entry)).toBe('/no-access');
      for (const auth of [cashier, administrator, stockKeeper]) {
        expect(businessDestination(auth, entry)).not.toMatch(/^\/platform|^\/$/);
      }
    }
  });

  it('takes nothing but the choice of door from the browser', () => {
    expect(entryFrom('pos')).toBe('pos');
    for (const value of ['POS', 'owner', 'platform', 'admin', '', null, undefined]) {
      expect(entryFrom(value)).toBe('portal');
    }
  });

  it('is decided after the session is verified, in the business being entered', () => {
    const enter = read('app', '[slug]', 'enter', 'route.ts');
    expect(enter).toContain(
      'resolveAuthContext(client, { requestedTenantId: membership.tenantId })',
    );
    expect(enter).toContain('businessDestination(context, entry)');
    const action = read('server', 'member-auth-actions.ts');
    expect(action).toContain("`/${slug}/enter${till ? '?to=pos' : ''}`");
    expect(read('app', '[slug]', 'member-pin-pad.tsx')).not.toContain("'/dashboard'");
  });
});

describe('the owner sign-in', () => {
  it('goes to the console', () => {
    expect(ownerDestination(undefined)).toBe('/platform');
    expect(ownerDestination('/platform/clients')).toBe('/platform/clients');
    expect(ownerDestination('/platform/onboarding?step=2')).toBe('/platform/onboarding?step=2');
  });

  it.each([
    '/dashboard',
    '/pos',
    '/',
    '/bobo',
    '/platformx',
    '//evil.example/platform',
    'https://evil.example/platform',
    '/platform/../dashboard',
    '/platform\\..\\pos',
  ])('never to %s', (next) => {
    expect(ownerDestination(next)).toBe('/platform');
  });

  it('is decided by the server action, from the verified result', () => {
    const action = read('server', 'platform-auth-actions.ts');
    expect(action).toContain("? '/platform/settings?change_pin=1'");
    expect(action).toContain(': ownerDestination(parsed.data.next)');
    const pad = read('components', 'owner-pin-pad.tsx');
    expect(pad).toContain('window.location.replace(result.data.destination)');
    expect(pad).not.toMatch(/router\.(replace|push)\(/);
  });
});

describe('the main address is the owner entry', () => {
  const entry = read('app', 'page.tsx');

  it('asks for the owner PIN, and sends a signed-in owner to the console', () => {
    expect(entry).toContain('<OwnerPinPad');
    expect(entry).toContain('Owner console');
    expect(entry).toContain('if (auth?.user.isPlatformAdmin) redirect(ownerDestination(next))');
  });

  it('leads to no business screen', () => {
    expect(entry).not.toMatch(/['"`]\/(dashboard|pos|sign-in)/);
  });

  it("is where the owner's old PIN address and emailed staff links no longer lead by mistake", () => {
    const proxy = read('proxy.ts');
    expect(proxy).toContain("if (pathname === '/platform/sign-in') {");
    expect(read('app', 'auth', 'callback', 'route.ts')).toContain(": '/dashboard'");
  });
});
