import { NextResponse } from 'next/server';
import { createLogger } from '@carl/shared';

/**
 * Where Content-Security-Policy violations are collected.
 *
 * ## Why this exists before the policy is enforced
 *
 * Carl's CSP is Report-Only, which is the right way to introduce one — but a Report-Only
 * policy with nowhere to report is only a warning in somebody's browser console, seen by
 * nobody. Enforcing a CSP without first knowing what it would have blocked is how a till
 * stops working in a shop; this is what makes that decision evidence-based rather than
 * hopeful.
 *
 * ## Unauthenticated by necessity
 *
 * The browser sends these reports itself, without cookies, and often for the sign-in page
 * where there is no session yet. So this endpoint is public, and treated accordingly:
 * nothing here trusts the body, nothing is stored, and the response is always 204 so it
 * cannot be used to probe anything.
 */
export const dynamic = 'force-dynamic';

const log = createLogger({ level: 'info', base: { module: 'csp' } });

/** The fields worth keeping. Everything else in a report is noise or fingerprinting. */
interface CspReport {
  'document-uri'?: unknown;
  'violated-directive'?: unknown;
  'effective-directive'?: unknown;
  'blocked-uri'?: unknown;
  'script-sample'?: unknown;
}

const text = (value: unknown, limit = 300): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();

    // Two wire formats exist: the original `{"csp-report": {...}}` and the newer
    // Reporting API array. Both are handled because browsers disagree about which to send.
    const reports: CspReport[] = Array.isArray(body)
      ? body.map((entry) => (entry as { body?: CspReport }).body ?? (entry as CspReport))
      : [((body as { 'csp-report'?: CspReport })?.['csp-report'] ?? body) as CspReport];

    for (const report of reports.slice(0, 10)) {
      if (typeof report !== 'object' || report === null) continue;
      /*
       * `script-sample` is deliberately NOT logged.
       *
       * It contains a fragment of whatever the page tried to execute, which on a POS could
       * be part of a form — a customer's phone number, a payment reference. A security log
       * that quietly accumulates fragments of real transactions is its own problem.
       */
      log.warn('csp violation', {
        documentUri: text(report['document-uri']),
        directive: text(report['effective-directive'] ?? report['violated-directive'], 120),
        blockedUri: text(report['blocked-uri'], 200),
      });
    }
  } catch {
    // A malformed report is not worth an error response. The browser cannot act on one.
  }

  // Always 204, whatever happened: this endpoint reveals nothing.
  return new NextResponse(null, { status: 204 });
}
