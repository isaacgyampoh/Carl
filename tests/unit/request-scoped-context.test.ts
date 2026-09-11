import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tenant context must belong to a request, never to the process.
 *
 * A Next.js server handles many businesses' requests in the same process at once. A tenant
 * held in a module-level variable would be shared by all of them, and the second request to
 * arrive would overwrite the first's business — the kind of leak that never shows up with
 * one client in testing and appears the day fifteen are online.
 *
 * So the modules that resolve who and where a caller is may not declare module-level mutable
 * state, and the resolved context is cached per request by React, not globally.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const CONTEXT_MODULES = [
  ['apps', 'web', 'src', 'lib', 'auth.ts'],
  ['apps', 'web', 'src', 'server', 'context-actions.ts'],
  ['apps', 'web', 'src', 'server', 'member-auth-actions.ts'],
  ['apps', 'web', 'src', 'server', 'staff-actions.ts'],
  ['apps', 'web', 'src', 'server', 'session-actions.ts'],
  ['apps', 'web', 'src', 'app', '[slug]', 'enter', 'route.ts'],
  ['packages', 'infrastructure', 'src', 'auth', 'resolve-auth-context.ts'],
];

describe('request-scoped tenant context', () => {
  it.each(CONTEXT_MODULES.map((p) => [p.join('/'), p] as const))(
    '%s holds no module-level mutable state',
    (_name, path) => {
      const source = read(...path);
      // A top-level `let` or `var` is state shared by every request the process serves.
      expect(source).not.toMatch(/^(let|var)\s/m);
    },
  );

  it('caches the resolved caller per request, not per process', () => {
    const auth = read('apps', 'web', 'src', 'lib', 'auth.ts');
    expect(auth).toContain("import { cache } from 'react'");
    expect(auth).toMatch(/export const currentAuth = cache\(/);
  });

  it('reads the chosen business and branch as filters from the request, never as grants', () => {
    const auth = read('apps', 'web', 'src', 'lib', 'auth.ts');
    expect(auth).toContain('requestedTenantId: uuidOrUndefined(store.get(TENANT_COOKIE)?.value)');
    expect(auth).toContain('requestedBranchId: uuidOrUndefined(store.get(BRANCH_COOKIE)?.value)');
    // And the resolver matches them against memberships RLS already permits.
    const resolver = read('packages', 'infrastructure', 'src', 'auth', 'resolve-auth-context.ts');
    expect(resolver).toContain(
      'memberships.find((m) => m.tenant_id === options.requestedTenantId)',
    );
  });

  it('only lets a business address in the members of that business', () => {
    const entry = read('apps', 'web', 'src', 'app', '[slug]', 'page.tsx');
    // The old unconditional redirect sent the platform owner into the owner console from any
    // client's address.
    expect(entry).not.toContain("redirect(auth.user.isPlatformAdmin ? '/platform' : '/dashboard')");
    expect(entry).toContain(".eq('tenants.slug', slug)");
  });
});
