import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..', '..', 'apps', 'web');
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8');

/**
 * What makes Carl installable, and what makes the installed copy open in the right place.
 */
describe('the web app manifest', () => {
  const manifest = JSON.parse(read('public', 'manifest.webmanifest')) as Record<string, unknown>;

  it('declares everything a browser needs to offer installation', () => {
    for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
      expect(manifest[key], `manifest is missing ${key}`).toBeDefined();
    }
    // A browser tab is not an application. Anything but standalone and Windows opens Carl
    // inside the browser chrome it was installed to escape.
    expect(manifest.display).toBe('standalone');
  });

  it('offers a maskable icon, so the Windows and Android icon is not a letterboxed square', () => {
    const icons = manifest.icons as { purpose?: string }[];
    expect(icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);
    expect(icons.some((i) => (i.purpose ?? 'any').includes('any'))).toBe(true);
  });

  it('points at no development host', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});

describe('a business gets its own manifest', () => {
  const route = read('src', 'app', '[slug]', 'manifest.webmanifest', 'route.ts');

  it('anchors start_url and scope to the business, not to the marketing page', () => {
    /*
     * The shared manifest has `start_url: "/"`. A shop that installed from their own address
     * got an application that opened on Carl's sales pitch and had to navigate to their till
     * every morning.
     */
    expect(route).toContain('start_url: `/${safe}`');
    expect(route).toContain('scope: `/${safe}`');
    // A distinct id, or two shops install over each other.
    expect(route).toContain('id: `/${safe}`');
  });

  it('refuses anything that is not a slug Carl would issue', () => {
    // The value is echoed into a document a browser installs as an application.
    expect(route).toMatch(/\^\[a-z0-9\]\[a-z0-9-\]\{0,48\}\[a-z0-9\]\$/);
    expect(route).toContain('status: 404');
  });

  it('reads nothing from the database, so it cannot confirm which businesses exist', () => {
    // `/[slug]` renders identically for every slug on purpose; this must not undo that.
    expect(route).not.toMatch(/supabase|from\(['"]tenants/);
  });

  it('is declared by the business entry page as its ONLY manifest', () => {
    /*
     * Live, a raw <link> in the page body sat AFTER the root layout's generic manifest, and
     * browsers use the first — so an installed shop app still opened on the marketing page.
     * The manifest must come from page metadata, which overrides the layout's.
     */
    const page = read('src', 'app', '[slug]', 'page.tsx');
    expect(page).toContain('manifest: `/${slug}/manifest.webmanifest`');
    expect(page, 'a raw manifest link adds a second manifest').not.toContain('rel="manifest"');
  });

  it('is declared by the owner sign-in page, which sits outside the (app) layout', () => {
    const page = read('src', 'app', 'platform', 'sign-in', 'page.tsx');
    expect(page).toContain("manifest: '/platform.webmanifest'");
    expect(page).not.toContain('rel="manifest"');
  });
});

describe('the service worker', () => {
  it('is registered, and only in production', () => {
    const source = read('src', 'components', 'service-worker.tsx');
    expect(source).toContain("navigator.serviceWorker.register('/sw.js')");
    // Registering in development serves a stale cache over every edit.
    expect(source).toContain("process.env.NODE_ENV === 'production'");
  });

  it('exists to be served', () => {
    expect(read('public', 'sw.js').length).toBeGreaterThan(0);
  });
});

describe('installation comes before the PIN pad', () => {
  const gate = read('src', 'components', 'install-gate.tsx');

  it('detects an already-installed application and gets out of the way', () => {
    expect(gate).toContain('display-mode: standalone');
    // iOS reports standalone nowhere else.
    expect(gate).toContain('navigator as unknown as { standalone?: boolean }');
  });

  it('holds the install prompt rather than firing it on load', () => {
    expect(gate).toContain('beforeinstallprompt');
    expect(gate).toContain('event.preventDefault()');
  });

  it('guards the owner console as well as a shop', () => {
    // Owner access is PWA-first too; only the shop entry was gated before.
    const owner = read('src', 'app', 'platform', 'sign-in', 'page.tsx');
    expect(owner).toContain("from '@/components/install-gate'");
    expect(owner).toContain('<InstallGate');
    expect(read('src', 'app', '[slug]', 'page.tsx')).toContain('<InstallGate');
  });

  it('can always be passed', () => {
    /*
     * A page cannot make a browser install anything — `beforeinstallprompt` is Chromium-only
     * and never fires on iOS Safari. A gate with no way through would lock out every shop on
     * an unsupported browser.
     */
    expect(gate).toContain('Continue in this browser');
  });

  it('tells a browser that cannot prompt what to do by hand', () => {
    expect(gate).toMatch(/Windows/);
    expect(gate).toMatch(/Add to Home Screen/);
  });
});
