/**
 * Who is on the till.
 *
 * ## Why a terminal needs a person as well as a credential
 *
 * The device secret proves *which till* is filing a sale. It does not prove *who* made it,
 * and `complete_sale` requires both: the database checks that the acting user is an active
 * member holding `sales.create` at that branch. A till that skipped this and synced as the
 * service role would attribute every sale to nobody and bypass every permission check the
 * database makes — which is precisely how a shared terminal becomes an unaudited one.
 *
 * ## Offline
 *
 * Signing in requires the network. Selling does not. A cashier signs in at the start of a
 * shift, and the session is what lets the queue drain later; sales made while the
 * connection is down are already safe on disk and carry the time they happened.
 *
 * The refresh token is held in the OS credential store, never in the local database.
 */

import { createClient } from '@supabase/supabase-js';

import { clearCashierToken, readCashierToken, storeCashierToken } from './keychain';

export interface Cashier {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface CashierSessionOptions {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly deviceId: string;
}

export type SignInResult =
  | { readonly ok: true; readonly cashier: Cashier }
  | { readonly ok: false; readonly detail: string };

export class CashierSession {
  // Inferred rather than annotated: `createClient`'s generic defaults do not line up with
  // a bare `SupabaseClient`, and widening to one loses the typing on `auth`.
  private readonly client: ReturnType<typeof createClient>;

  constructor(private readonly options: CashierSessionOptions) {
    this.client = createClient(options.supabaseUrl, options.anonKey, {
      auth: {
        // Persistence is handled here, into the OS credential store. The default is the
        // webview's local storage, which is a file on a machine that gets stolen.
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) {
      // Deliberately not distinguishing "no such account" from "wrong password": a till
      // stands in a public place, and the difference is a way to enumerate staff.
      return { ok: false, detail: 'That email address and password were not recognised.' };
    }

    await storeCashierToken(this.options.deviceId, data.session.refresh_token);
    return { ok: true, cashier: toCashier(data.user) };
  }

  /**
   * Restores the previous shift's session, if the token is still good.
   *
   * Returns null rather than throwing when there is none, or when it has expired: both
   * mean the same thing to the caller — show the sign-in screen.
   */
  async restore(): Promise<Cashier | null> {
    const refreshToken = await readCashierToken(this.options.deviceId);
    if (!refreshToken) return null;

    const { data, error } = await this.client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session || !data.user) return null;

    // Refresh tokens rotate: the old one is spent, and failing to store the new one would
    // sign the cashier out at the next restart for no visible reason.
    await storeCashierToken(this.options.deviceId, data.session.refresh_token);
    return toCashier(data.user);
  }

  /**
   * A currently-valid access token for the sync route.
   *
   * Refreshed on demand rather than kept: an access token is short-lived by design, and a
   * terminal that has been offline for hours will always be holding a stale one.
   */
  async accessToken(): Promise<string | null> {
    const existing = await this.client.auth.getSession();
    const session = existing.data.session;
    // A minute of headroom, so a token does not expire between here and the server.
    const expiresAt = session?.expires_at;
    if (session && expiresAt && expiresAt * 1000 - Date.now() > 60_000) {
      return session.access_token;
    }

    const refreshToken = await readCashierToken(this.options.deviceId);
    if (!refreshToken) return null;

    const { data, error } = await this.client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return null;

    await storeCashierToken(this.options.deviceId, data.session.refresh_token);
    return data.session.access_token;
  }

  async signOut(): Promise<void> {
    await clearCashierToken(this.options.deviceId);
    await this.client.auth.signOut().catch(() => undefined);
  }
}

function toCashier(user: {
  id: string;
  email?: string;
  user_metadata?: { full_name?: unknown };
}): Cashier {
  const name = user.user_metadata?.full_name;
  return {
    userId: user.id,
    email: user.email ?? '',
    displayName: typeof name === 'string' && name.length > 0 ? name : (user.email ?? 'Cashier'),
  };
}
