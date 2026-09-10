import { describe, expect, it } from 'vitest';

import nextConfig from '../../apps/web/next.config';

/**
 * The response headers the browser actually enforces.
 *
 * These had no test at all, which is how a security header regresses: nothing about the
 * application stops working when one is dropped, so nothing tells you it happened. The
 * whole point of a header like `base-uri` is that its absence is invisible right up until
 * it is exploited.
 */
describe('web security headers', () => {
  async function headersFor(path: string): Promise<Map<string, string>> {
    const groups = await nextConfig.headers!();
    const found = new Map<string, string>();
    for (const group of groups) {
      // Every rule here is `/:path*`; this keeps the test honest if that stops being true.
      if (group.source !== '/:path*' && group.source !== path) continue;
      for (const header of group.headers) found.set(header.key.toLowerCase(), header.value);
    }
    return found;
  }

  it('enforces the directives that carry no breakage risk', async () => {
    const csp = (await headersFor('/pos')).get('content-security-policy');
    expect(csp, 'no ENFORCING Content-Security-Policy is sent').toBeDefined();

    // Each of these is enforced because the application verifiably does not need it:
    // no <object>, no <embed>, no <base>, and every form is a same-origin Server Action.
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does not enforce a directive it cannot yet honour', async () => {
    /*
     * The guard against someone "tidying" the two policies into one.
     *
     * Next serves inline bootstrap scripts. An enforcing `script-src` would either need a
     * nonce on every response or `'unsafe-inline'`, and the second is worse than not having
     * the directive at all because it looks like protection. Enforcing it without either
     * would blank the till.
     */
    const csp = (await headersFor('/pos')).get('content-security-policy')!;
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('default-src');
    expect(csp, 'unsafe-inline must never appear in the ENFORCING policy').not.toContain(
      'unsafe-inline',
    );
  });

  it('still measures the full policy, with somewhere to report', async () => {
    // A report-only policy with no report-uri is a message to an empty room.
    const reportOnly = (await headersFor('/pos')).get('content-security-policy-report-only');
    expect(reportOnly).toContain('report-uri /api/csp-report');
    expect(reportOnly).toContain("script-src 'self' 'unsafe-inline'");
    expect((await headersFor('/pos')).get('content-security-policy')).toContain(
      'report-uri /api/csp-report',
    );
  });

  it('sends the transport and framing headers a POS over public wifi needs', async () => {
    const headers = await headersFor('/pos');

    // Staff sign in over shop wifi and mobile data. Without HSTS the first request of the
    // day is plaintext and downgradable.
    const hsts = headers.get('strict-transport-security');
    expect(hsts).toContain('includeSubDomains');
    const maxAge = Number(/max-age=(\d+)/.exec(hsts ?? '')?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
    // `preload` is a months-long commitment to undo. It must not appear by accident.
    expect(hsts).not.toContain('preload');

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('grants no camera, microphone or location it does not use', async () => {
    // A barcode scanner is a keyboard, not a camera — but scanning by camera is a plausible
    // future, so `camera=(self)` is deliberate while the other two are closed outright.
    const permissions = (await headersFor('/pos')).get('permissions-policy');
    expect(permissions).toContain('microphone=()');
    expect(permissions).toContain('geolocation=()');
  });

  it('does not advertise the framework', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('fails the build on a type error rather than shipping', () => {
    expect(nextConfig.typescript?.ignoreBuildErrors).toBe(false);
  });
});
