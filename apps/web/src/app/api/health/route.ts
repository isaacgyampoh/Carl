import { NextResponse } from 'next/server';

/**
 * Liveness endpoint.
 *
 * Deliberately reports nothing about configuration or dependencies: an unauthenticated
 * health check that names which environment variables are missing is a reconnaissance tool.
 * Dependency health belongs behind platform-admin authentication (Phase 9).
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'carl-web', time: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
