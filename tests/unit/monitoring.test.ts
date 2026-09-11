import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Knowing when production is broken.
 *
 * Carl used to fail silently: the shop saw a broken screen, the platform's logs held the
 * detail, and the owner found out when somebody phoned. Errors are recorded now, the console
 * shows them, and a scheduled check counts them and raises an alert.
 *
 * The rule that shapes all of it: an error record is a fact about a failure, never a copy of
 * what the request carried.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const web = (...p: string[]) => read('apps', 'web', 'src', ...p);

describe('recording an error', () => {
  const hook = web('instrumentation.ts');

  it('happens for every unhandled server error, through Next.js itself', () => {
    expect(hook).toContain('export const onRequestError');
    expect(hook).toContain("from('app_errors')");
  });

  it('keeps no stack, no body, no headers and no query string', () => {
    expect(hook).not.toMatch(/\.stack|request\.body|JSON\.stringify\(request/);
    // The path only: a query string carries search terms, ids, sometimes a token.
    expect(hook).toContain("(request.path ?? '').split('?')[0]");
    expect(hook).toContain('message.slice(0, 2000)');
  });

  it('never turns a failed request into a second failure', () => {
    expect(hook).toMatch(/try \{[\s\S]*\} catch \{[\s\S]*\}/);
    // The edge runtime has no service-role client and no business holding one.
    expect(hook).toContain("if (process.env.NEXT_RUNTIME !== 'nodejs') return;");
  });

  it('is stored where only the platform owner can read it', () => {
    const migration = read('supabase', 'migrations', '20260101004100_app_errors.sql');
    expect(migration).toContain('alter table app_errors enable row level security');
    expect(migration).toContain('alter table app_errors force row level security');
    expect(migration).toContain('for select using (app.is_platform_admin())');
    expect(migration).toContain('revoke all on app_errors from anon, authenticated');
    // Nothing keeps errors for ever.
    expect(migration).toContain("occurred_at < now() - interval '30 days'");
  });
});

describe('the health endpoint the scheduled check reads', () => {
  const route = web('app', 'api', 'monitor', 'route.ts');

  it('does not exist without a configured secret, rather than announcing itself', () => {
    expect(route).toContain('const expected = serverEnv().CARL_MONITOR_TOKEN;');
    expect(route).toContain("return new NextResponse('Not found', { status: 404 });");
    // A 401 would confirm that Carl has monitoring worth guessing a token for.
    expect(route).not.toContain('status: 401');
  });

  it('compares the secret without leaking how much of it was right', () => {
    expect(route).toContain('timingSafeEqual');
    expect(route).toContain('left.length === right.length');
  });

  it('returns counts, never an error message', () => {
    expect(route).toContain('last15m');
    expect(route).toContain('last24h');
    // The row's message is never selected, and never reaches the response.
    expect(route).not.toContain("select('message");
    expect(route).not.toContain('last.data.message');
  });

  it('is reachable without a session, because a cron job has no cookie', () => {
    const proxy = web('proxy.ts');
    const publicBlock = proxy.slice(proxy.indexOf('const isPublic'), proxy.indexOf('if (!user'));
    expect(publicBlock).toContain("pathname === '/api/monitor'");
  });
});

describe('the scheduled check', () => {
  const workflow = read('.github', 'workflows', 'monitor.yml');

  it('runs on a schedule and can be run by hand', () => {
    expect(workflow).toContain("- cron: '*/15 * * * *'");
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('raises an issue when liveness fails or errors appear', () => {
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('gh issue comment');
    expect(workflow).toContain(
      "steps.live.outputs.failed != '' || steps.errors.outputs.failed != ''",
    );
  });

  it('carries the secret in a header, never in a URL', () => {
    expect(workflow).toContain('authorization: Bearer ${{ secrets.CARL_MONITOR_TOKEN }}');
    expect(workflow).not.toMatch(/api\/monitor\?[^"']*token/);
  });
});

describe('the console shows them', () => {
  it('has a health page behind the owner guard', () => {
    const page = web('app', '(owner)', 'platform', 'health', 'page.tsx');
    expect(page).toContain('await requirePlatformAdmin();');
    expect(page).toContain("from('app_errors')");
    const shell = web('components', 'app-shell.tsx');
    expect(shell).toContain("['/platform/health', 'Health']");
  });
});
