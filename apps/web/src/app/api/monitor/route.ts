import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { serverEnv } from '@carl/infrastructure/config/server-env';

import { serviceRoleClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * How production is, for the scheduled health check.
 *
 * Counts, and nothing else. An error's message can quote a price, a customer or a shop, so this
 * never returns one — the console shows those to the owner, behind the owner's own sign-in. The
 * caller proves itself with a shared secret rather than a session, because it is a cron job
 * with no cookie jar.
 */
function presentedToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

/** Compared without leaking how much of the token was right. */
function matches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = serverEnv().CARL_MONITOR_TOKEN;

  /*
   * Unconfigured, or presented with the wrong secret, this endpoint simply does not exist.
   * A 401 would confirm that Carl has monitoring worth guessing a token for.
   */
  if (expected === undefined || !matches(presentedToken(request), expected)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const client = serviceRoleClient();
  const since = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const [recent, day, last] = await Promise.all([
    client
      .from('app_errors')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', since(15)),
    client
      .from('app_errors')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', since(60 * 24)),
    client
      .from('app_errors')
      .select('occurred_at, route, digest')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return NextResponse.json(
    {
      status: 'ok',
      errors: { last15m: recent.count ?? 0, last24h: day.count ?? 0 },
      // The digest matches the platform's own logs; the message stays in the console.
      lastError: last.data
        ? { occurredAt: last.data.occurred_at, route: last.data.route, digest: last.data.digest }
        : null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
