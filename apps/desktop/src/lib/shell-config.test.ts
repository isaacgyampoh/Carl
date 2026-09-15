import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The window and the policy the till opens with.
 *
 * Both of these have been wrong in a way nothing caught. The Content-Security-Policy still
 * named a Vercel preview months after the product moved to its own domain, so every call the
 * terminal made — activation, catalogue, sync — was refused by the webview before it left the
 * machine. And the window had no colour of its own, so from the moment it opened until
 * WebView2 had started and React had mounted, a cashier was looking at an empty black
 * rectangle and reporting, accurately, that Carl shows a black screen.
 *
 * Neither is visible in a unit test of a component, and neither shows up on a developer's
 * machine where the window paints in a blink. So they are asserted here, against the files
 * that actually ship.
 */
const desktop = (...parts: string[]) => join(import.meta.dirname, '..', '..', ...parts);

const config = JSON.parse(readFileSync(desktop('src-tauri', 'tauri.conf.json'), 'utf8')) as {
  app: {
    windows: { backgroundColor?: string }[];
    security: { csp: string };
  };
};
const html = readFileSync(desktop('index.html'), 'utf8');
const env = readFileSync(desktop('src', 'lib', 'env.ts'), 'utf8');

describe('the shell the till opens in', () => {
  it('lets the webview reach the Carl the application actually calls', () => {
    // The default in env.ts is the address every shipped terminal uses; a build can override
    // it, but a build that cannot reach the default is broken for everybody else.
    const fallback = /CARL_URL: string = env\.VITE_CARL_URL \?\? '([^']+)'/.exec(env)?.[1];
    expect(fallback, 'env.ts no longer states a default Carl URL').toBeDefined();

    const origin = new URL(fallback!).origin;
    const connect = /connect-src ([^;]+)/.exec(config.app.security.csp)?.[1] ?? '';
    expect(connect.split(/\s+/), `the desktop CSP would refuse every call to ${origin}`).toContain(
      origin,
    );
  });

  it('still refuses everything the till has no reason to reach', () => {
    const csp = config.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp, 'an injected script could then run').not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp, 'a till has no reason to load a remote image').toContain("img-src 'self' data:");
  });

  it('opens a window that is already the colour of the application', () => {
    const background = config.app.windows[0]?.backgroundColor;
    expect(background, 'without this the window is an OS-coloured void until React mounts').toMatch(
      /^#[0-9a-fA-F]{6}$/,
    );
    // The same ground the stylesheet paints, so opening is one colour rather than two.
    expect(background!.toLowerCase()).toBe('#0f1115');
  });

  it('paints Carl before the bundle has been parsed', () => {
    // A cold shop machine takes seconds to start a webview. Whatever is in this file is the
    // only thing on screen for that time, so it has to be more than an empty div.
    expect(html, 'index.html has no inline styling to paint with').toContain('<style>');
    expect(html).toMatch(/background:\s*#0f1115/i);
    expect(html, 'nothing tells the cashier the till is starting').toMatch(/Starting the till/i);
  });

  it('loads the boot guard before the bundle it is there to report on', () => {
    const guard = html.indexOf('boot-guard.js');
    const bundle = html.indexOf('/src/main.tsx');
    expect(guard, 'index.html no longer loads the boot guard').toBeGreaterThan(-1);
    expect(guard, 'the guard must be in place before the bundle can fail').toBeLessThan(bundle);
  });

  it('listens for a failed download, which does not bubble', () => {
    const guard = readFileSync(desktop('public', 'boot-guard.js'), 'utf8');
    // A <script> that 404s fires an error event on the element and it does not bubble, so a
    // plain window listener never sees it. Without the capture phase the window sat on
    // "Starting the till…" until the timer noticed, twenty-five seconds later.
    expect(guard).toMatch(/addEventListener\(\s*'error',[\s\S]*?,\s*true,?\s*\)/);
    expect(guard).toContain('unhandledrejection');
  });

  it('does not clear the boot mark until something has been drawn', () => {
    const main = readFileSync(desktop('src', 'main.tsx'), 'utf8');
    const boundary = readFileSync(desktop('src', 'ui', 'boot-boundary.tsx'), 'utf8');

    // `render()` returning is not the same as anything having been drawn. Clearing the mark
    // on the next line is what turned a failed first render into an empty window.
    expect(main, 'the mark is cleared before the first commit again').not.toMatch(
      /getElementById\('boot'\)/,
    );
    expect(main).toContain('<BootBoundary>');
    expect(boundary).toContain('componentDidMount');
    expect(boundary).toContain("getElementById('boot')");
  });

  it('catches a render that throws instead of unmounting to nothing', () => {
    const boundary = readFileSync(desktop('src', 'ui', 'boot-boundary.tsx'), 'utf8');
    expect(boundary).toContain('getDerivedStateFromError');
    expect(boundary).toContain('componentDidCatch');
    // Whatever it shows, it has to offer the way out.
    expect(boundary).toMatch(/Start again/);
  });

  it('states one version, in all five places that state one', () => {
    /*
     * The installer's file version comes from tauri.conf.json, the crate's from Cargo.toml
     * and Cargo.lock, npm's from package.json, and what the running till reports comes from
     * env.ts. A release is tagged by hand, and the tag is checked against the installer — so
     * a file left behind does not fail the build, it ships a terminal that lies about which
     * version it is when a shop reports a fault.
     */
    const version = JSON.parse(readFileSync(desktop('src-tauri', 'tauri.conf.json'), 'utf8'))
      .version as string;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const pkg = JSON.parse(readFileSync(desktop('package.json'), 'utf8')) as { version: string };
    expect(pkg.version, 'apps/desktop/package.json').toBe(version);

    const cargo = readFileSync(desktop('src-tauri', 'Cargo.toml'), 'utf8');
    expect(/^version = "([^"]+)"/m.exec(cargo)?.[1], 'Cargo.toml').toBe(version);

    const lock = readFileSync(desktop('src-tauri', 'Cargo.lock'), 'utf8');
    const locked = /name = "carl-desktop"\nversion = "([^"]+)"/.exec(lock)?.[1];
    expect(locked, 'Cargo.lock').toBe(version);

    expect(
      /VITE_APP_VERSION \?\? '([^']+)'/.exec(env)?.[1],
      'env.ts — what a till reports when a shop rings up about it',
    ).toBe(version);
  });
});
