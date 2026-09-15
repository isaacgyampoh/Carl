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

  it('takes the boot mark out of the page once the application has mounted', () => {
    const main = readFileSync(desktop('src', 'main.tsx'), 'utf8');
    expect(main).toContain("getElementById('boot')");
    expect(main).toContain('.remove()');
  });
});
