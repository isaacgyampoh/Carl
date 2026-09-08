import { NextResponse, type NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * Exchanges an email link or invitation code for a session.
 *
 * Used by password-reset and staff-invitation emails.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next');

  if (!code) {
    return NextResponse.redirect(`${origin}/sign-in?error=missing_code`);
  }

  const client = await supabase();
  const { error } = await client.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/sign-in?error=invalid_code`);
  }

  // Same open-redirect guard as the sign-in form: `next` is attacker-controlled.
  const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return NextResponse.redirect(`${origin}${destination}`);
}
