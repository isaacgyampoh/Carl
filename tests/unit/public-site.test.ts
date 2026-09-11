import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the public marketing page may and may not contain.
 *
 * Carl's administration console can onboard, suspend and bill every customer on the
 * platform. A link to it on the public homepage gains a shopkeeper nothing and hands an
 * attacker the door to knock on, so the page carries no sign-in entrance at all — shops
 * reach Carl at the address their business was given, and the platform owner through the
 * installed application.
 *
 * Asserted on the source because this is about what is ABSENT, and nothing breaks when an
 * absent thing comes back.
 */
describe('the public marketing page', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'apps', 'web', 'src', 'app', 'page.tsx'),
    'utf8',
  );

  it('offers no owner or platform sign-in link', () => {
    expect(source).not.toContain('/platform/sign-in');
    expect(source.toLowerCase()).not.toContain('owner login');
  });

  it('does not link into the authenticated application at all', () => {
    for (const route of ['/platform', '/dashboard', '/pos']) {
      expect(source, `the marketing page links to ${route}`).not.toContain(`href="${route}"`);
    }
  });

  it('still explains the product', () => {
    // Removing the sign-in link must not quietly remove the marketing copy with it.
    expect(source).toMatch(/point of sale/i);
  });
});
