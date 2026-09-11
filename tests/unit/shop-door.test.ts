import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DOOR_COOKIE, shopDoor } from '../../apps/web/src/lib/shop-door';

/**
 * A signed-out screen that belongs to a business returns to that business's PIN door.
 *
 * Found in production: signed out, /bobo/enter redirected to /sign-in, the email-and-password
 * page a PIN user cannot use. The same dead end met a cashier whose session ended on /pos.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const RESERVED = new Set(['api', 'dashboard', 'platform', 'pos', 'sign-in']);
const isShop = (segment: string) =>
  /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(segment) && !RESERVED.has(segment);

describe('the door for a signed-out request', () => {
  it('is the business named in the address', () => {
    expect(shopDoor('/bobo/enter', undefined, isShop)).toBe('/bobo');
    // The address wins over what the device remembers.
    expect(shopDoor('/bobo/new-pin', 'another-shop', isShop)).toBe('/bobo');
  });

  it("is the business this device last signed in at, for the portal's shared screens", () => {
    expect(shopDoor('/dashboard', 'bobo', isShop)).toBe('/bobo');
  });

  it("is that business's till door when the session ended at the till", () => {
    // Back to the till app's door, which returns to the till — not to the portal's.
    expect(shopDoor('/pos', 'bobo', isShop)).toBe('/bobo/pos');
    expect(shopDoor('/pos/receipt', 'bobo', isShop)).toBe('/bobo/pos');
  });

  it('is never an application route mistaken for a business', () => {
    expect(shopDoor('/pos', undefined, isShop)).toBeNull();
    expect(shopDoor('/dashboard', 'platform', isShop)).toBeNull();
  });

  it('ignores a remembered value that is not a business address', () => {
    expect(shopDoor('/pos', '../../evil', isShop)).toBeNull();
    expect(shopDoor('/pos', 'https://evil.example', isShop)).toBeNull();
  });

  it('is what the proxy uses, with its own reserved names, and PIN sign-in remembers it', () => {
    const proxy = read('apps', 'web', 'src', 'proxy.ts');
    // Whitespace-tolerant: the formatter decides how the call wraps, not this test.
    expect(proxy).toMatch(
      /shopDoor\(\s*pathname,\s*request\.cookies\.get\(DOOR_COOKIE\)\?\.value,/,
    );
    expect(proxy).toMatch(
      /\(segment\)\s*=>\s*SLUG\.test\(segment\)\s*&&\s*!RESERVED\.has\(segment\)/,
    );
    const pin = read('apps', 'web', 'src', 'server', 'member-auth-actions.ts');
    expect(pin).toContain('store.set(DOOR_COOKIE');
    expect(DOOR_COOKIE).toBe('carl_door');
  });
});
