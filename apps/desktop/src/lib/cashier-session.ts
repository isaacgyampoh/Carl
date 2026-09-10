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
  /**
   * Proves which till is asking.
   *
   * Supplied as a function rather than a value because the secret lives in the OS
   * credential store, and reading it is asynchronous. Holding it in memory for the life of
   * the application would put it in a crash dump.
   */
  readonly deviceSecret: () => Promise<string | null>;
  /** Where Carl's server lives. PIN verification happens there, never on the till. */
  readonly carlUrl: string;
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

  /**
   * Signs a cashier in with their four-digit PIN.
   *
   * The till sends its own device secret and the PIN to Carl's server, which verifies both
   * against the database and returns a session. Verification cannot happen here: it needs
   * the service-role key and the device pepper, and neither may ever sit in a bundle
   * installed on a shop counter.
   *
   * The till previously asked for an email and a password. Carl's staff have neither —
   * they are issued PINs — so the one client that actually sells things was the one client
   * nobody could sign into.
   */
  async signInWithPin(pin: string): Promise<SignInResult> {
    /*
     * This method's contract is that it ANSWERS. It never throws.
     *
     * The sign-in screen disables the PIN pad while a check is in flight and re-enables it
     * from the result. A rejected promise skips that, so the pad stays disabled with a
     * cashier standing in front of it and no way back except restarting the till. Reading
     * the OS keychain is a Tauri call that can fail, and it used to sit outside the only
     * try in here.
     */
    let secret: string | null;
    try {
      secret = await this.options.deviceSecret();
    } catch {
      return {
        ok: false,
        detail: 'This terminal could not read its stored credentials. Restart it, then try again.',
      };
    }
    if (!secret) {
      return { ok: false, detail: 'This terminal is not activated.' };
    }

    let payload: {
      status?: string;
      accessToken?: string;
      refreshToken?: string;
      cashierName?: string | null;
    };
    try {
      const response = await fetch(`${this.options.carlUrl}/api/device/staff-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: this.options.deviceId, deviceSecret: secret, pin }),
      });
      payload = (await response.json()) as typeof payload;
    } catch {
      // Signing in needs the network; selling does not. Said plainly, because a cashier
      // seeing "failed to fetch" mid-queue has no idea whether to keep trying.
      return { ok: false, detail: 'Carl cannot be reached. Check the internet connection.' };
    }

    if (payload.status === 'LOCKED') {
      return { ok: false, detail: 'Too many incorrect PINs. Try again shortly.' };
    }
    if (payload.status !== 'OK' || !payload.accessToken || !payload.refreshToken) {
      // The same answer for a wrong PIN and an unknown one: a till stands in a public
      // place, and the difference is a way to work out who does and does not work here.
      return { ok: false, detail: 'That PIN is not correct.' };
    }

    let session: Awaited<ReturnType<typeof this.client.auth.setSession>>;
    try {
      session = await this.client.auth.setSession({
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
      });
    } catch {
      return { ok: false, detail: 'Could not start the shift. Try again.' };
    }
    const { data, error } = session;
    if (error || !data.session || !data.user) {
      return { ok: false, detail: 'Could not start the shift. Try again.' };
    }

    /*
     * Storing the token must not fail the sign-in that already succeeded.
     *
     * The cashier is authenticated at this point. Rejecting here would strand them on a
     * disabled PIN pad after a sign-in that worked; the only thing actually lost is the
     * shift surviving a restart of the till.
     */
    try {
      await storeCashierToken(this.options.deviceId, data.session.refresh_token);
    } catch {
      // Nothing to tell the cashier: they are signed in and can sell.
    }
    return { ok: true, cashier: toCashier(data.user) };
  }

  /**
   * Restores the previous shift's session, if the token is still good.
   *
   * Returns null rather than throwing when there is none, or when it has expired: both
   * mean the same thing to the caller — show the sign-in screen.
   */
  async restore(): Promise<Cashier | null> {
    /*
     * Null, never a throw — the doc comment above says so, and the caller relies on it.
     *
     * Startup treats a rejection here as "Carl could not open its local database", which is
     * both wrong and unactionable when what actually happened is a keychain read failing.
     * Every outcome that is not a usable session means the same thing: show the PIN screen.
     */
    try {
      const refreshToken = await readCashierToken(this.options.deviceId);
      if (!refreshToken) return null;

      const { data, error } = await this.client.auth.refreshSession({
        refresh_token: refreshToken,
      });
      if (error || !data.session || !data.user) return null;

      // Refresh tokens rotate: the old one is spent, and failing to store the new one would
      // sign the cashier out at the next restart for no visible reason. It is still not
      // worth refusing a shift that is otherwise ready to start.
      await storeCashierToken(this.options.deviceId, data.session.refresh_token).catch(
        () => undefined,
      );
      return toCashier(data.user);
    } catch {
      return null;
    }
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
