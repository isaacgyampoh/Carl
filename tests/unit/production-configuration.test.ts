import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * `downloads.ts` is server-only code, and the `server-only` package exists to throw when it
 * is imported anywhere else. That guard is correct and worth keeping, so it is stubbed here
 * rather than removed from the module under test.
 */
vi.mock('server-only', () => ({}));

/*
 * `process.env.NODE_ENV` is typed as read-only, because application code has no business
 * reassigning it. A test that exercises production-only behaviour does, so it goes through
 * an explicit record view rather than a cast at each call site.
 */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/**
 * Configuration that must not silently invent a value in production.
 *
 * `clientAppUrl()` is not internal plumbing: it becomes the shop address shown on the
 * onboarding handover screen, with a Copy button next to it. It used to fall back to
 * `http://localhost:3000`, so a misconfigured deployment handed a paying merchant a link
 * that resolves to their own machine — silently. The page rendered, the button copied, and
 * the failure surfaced days later as "the link you gave me doesn't work".
 */
describe('the merchant-facing application URL', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  async function clientAppUrl() {
    const mod = await import('../../apps/web/src/lib/downloads.js');
    return mod.clientAppUrl;
  }

  it('never hands out localhost in production', async () => {
    vi.resetModules();
    setNodeEnv('production');
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

    const fn = await clientAppUrl();
    expect(() => fn()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('uses the configured URL when there is one', async () => {
    vi.resetModules();
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_APP_URL = 'https://carl.example';

    const fn = await clientAppUrl();
    expect(fn()).toBe('https://carl.example');
  });

  it('falls back to the deployment URL rather than to localhost', async () => {
    vi.resetModules();
    setNodeEnv('production');
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'carl-red.vercel.app';

    const fn = await clientAppUrl();
    expect(fn()).toBe('https://carl-red.vercel.app');
  });

  it('still defaults to localhost in development, where that is the point', async () => {
    vi.resetModules();
    setNodeEnv('development');
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

    const fn = await clientAppUrl();
    expect(fn()).toBe('http://localhost:3000');
  });
});
