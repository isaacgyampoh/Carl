import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..', '..', 'apps', 'web');
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8');

/**
 * What Carl installs, and where the installed app opens.
 *
 * The installed app is the POS client. The owner console is not installable: it is used in the
 * browser at the main address. Before this, the root layout gave every page a manifest whose
 * start_url was `/`, so an app installed from the main address or from a till opened the main
 * website, and the console was a second installable "Carl Owner" beside the till.
 */
describe('the generic POS app manifest', () => {
  const manifest = JSON.parse(read('public', 'manifest.webmanifest')) as Record<string, unknown>;

  it('declares everything a browser needs to offer installation', () => {
    for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
      expect(manifest[key], `manifest is missing ${key}`).toBeDefined();
    }
    // A browser tab is not an application.
    expect(manifest.display).toBe('standalone');
  });

  it('is the till: named Carl POS and starting at the POS, never at the main address', () => {
    expect(manifest.name).toBe('Carl POS');
    expect(manifest.start_url).toBe('/pos');
  });

  it('keeps the id existing installs already have, so they update rather than duplicate', () => {
    expect(manifest.id).toBe('/');
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

describe("a business's POS app manifest", () => {
  const route = read('src', 'app', '[slug]', 'manifest.webmanifest', 'route.ts');

  it("starts at the business's till door, under the POS app's name", () => {
    expect(route).toContain('start_url: `/${safe}/pos`');
    expect(route).toContain("short_name: 'Carl POS'");
    expect(route).toContain('name: `Carl POS · ${safe}`');
  });

  it('keeps its identity and whole-origin scope', () => {
    // The same id as before, so an installed shop app updates to the new start_url in place.
    expect(route).toContain('id: `/${safe}`');
    // The till's screens (/pos, /register, /sales) are shared routes, not under /{slug}.
    expect(route).toContain("scope: '/'");
  });

  it('is revalidated on every fetch, so an installed app does not keep an old start_url', () => {
    expect(route).toContain("'cache-control': 'no-cache'");
  });

  it('refuses anything that is not a slug Carl would issue', () => {
    expect(route).toMatch(/\^\[a-z0-9\]\[a-z0-9-\]\{0,48\}\[a-z0-9\]\$/);
    expect(route).toContain('status: 404');
  });

  it('reads nothing from the database, so it cannot confirm which businesses exist', () => {
    expect(route).not.toMatch(/supabase|from\(['"]tenants/);
  });

  it("is the ONLY manifest of the till's door and of the business's address", () => {
    for (const page of [
      read('src', 'app', '[slug]', 'pos', 'page.tsx'),
      read('src', 'app', '[slug]', 'page.tsx'),
    ]) {
      expect(page).toContain('manifest: `/${slug}/manifest.webmanifest`');
      expect(page, 'a raw manifest link adds a second manifest').not.toContain('rel="manifest"');
    }
  });

  it('is rendered in <head>, where browsers read a manifest, never streamed into <body>', () => {
    // The business layout computes its manifest from the session. Streamed, it landed in the
    // body on every screen after the PIN and the POS app could not be installed from them.
    expect(read('next.config.ts')).toMatch(/^\s*htmlLimitedBots: \/\.\*\/,$/m);
  });

  it("is what a business's own screens offer to install", () => {
    const layout = read('src', 'app', '(app)', 'layout.tsx');
    expect(layout).toContain('manifest = `/${data.slug}/manifest.webmanifest`');
    expect(layout).toContain("let manifest = '/manifest.webmanifest'");
  });
});

describe('the owner console is not an installable app', () => {
  it('no page inherits a manifest from the root layout', () => {
    const root = read('src', 'app', 'layout.tsx');
    expect(root).not.toMatch(/^\s*manifest:/m);
    expect(root).not.toMatch(/capable:\s*true/);
  });

  it('the main address declares no manifest and puts no install gate before the PIN', () => {
    const entry = read('src', 'app', 'page.tsx');
    expect(entry).not.toMatch(/manifest:/);
    expect(entry).not.toContain('InstallGate');
  });

  it('the console declares no manifest, and the old owner manifest is gone', () => {
    expect(read('src', 'app', '(owner)', 'platform', 'layout.tsx')).not.toMatch(/manifest:/);
    expect(existsSync(join(WEB, 'public', 'platform.webmanifest'))).toBe(false);
  });
});

describe('the service worker', () => {
  const sw = read('public', 'sw.js');

  it('is registered only in production, bypassing the HTTP cache and checking for updates', () => {
    const source = read('src', 'components', 'service-worker.tsx');
    expect(source).toContain("register('/sw.js', { updateViaCache: 'none' })");
    expect(source).toContain('registration.update()');
    // Registering in development serves a stale cache over every edit.
    expect(source).toContain("process.env.NODE_ENV === 'production'");
  });

  it('has a new version, and deletes every cache from another version when it activates', () => {
    expect(sw).toMatch(/const VERSION = 'carl-v3'/);
    expect(sw).toContain('keys.filter((key) => !key.startsWith(VERSION))');
  });

  it('caches no page and no manifest, and asks the network for every navigation', () => {
    const precache = /const PRECACHE = \[([^\]]*)\]/.exec(sw)?.[1] ?? '';
    expect(precache).not.toContain('manifest');
    expect(precache).not.toMatch(/'\/'|'\/platform|'\/pos|'\/dashboard/);
    // So no cached page can decide where a launch or a sign-in goes.
    expect(sw).toMatch(/request\.mode === 'navigate'[\s\S]*fetch\(request\)\.catch/);
  });
});

describe('installation is offered at the till, under its own name', () => {
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

  it("guards the till's door, and neither the business portal nor the owner entry", () => {
    const pos = read('src', 'app', '[slug]', 'pos', 'page.tsx');
    expect(pos).toContain('<InstallGate');
    expect(pos).toContain('title="Install Carl POS"');
    expect(read('src', 'app', '[slug]', 'page.tsx')).not.toContain('<InstallGate');
    expect(read('src', 'app', 'page.tsx')).not.toContain('<InstallGate');
  });

  it('can always be passed', () => {
    // `beforeinstallprompt` is Chromium-only and never fires on iOS Safari. A gate with no way
    // through would lock out every shop on an unsupported browser.
    expect(gate).toContain('Continue in this browser');
  });

  it('tells a browser that cannot prompt what to do by hand', () => {
    expect(gate).toMatch(/Windows/);
    expect(gate).toMatch(/Add to Home Screen/);
  });
});
