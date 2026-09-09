import { describe, expect, it } from 'vitest';
import pg from 'pg';

import { connect, isConnectionError } from '../support/pg-database.js';

/**
 * The real-PostgreSQL driver retries a statement when the connection dies, because a run
 * takes the better part of an hour and a pooled connection held that long will eventually
 * be recycled. One dropped connection once cost 242 skipped tests.
 *
 * That retry is only safe if it can never re-run a statement the *server* refused. Most of
 * this suite asserts that writes fail — cross-tenant reads, price tampering, RLS denials —
 * so a retry that swallowed a refusal would turn a security test into a green light.
 *
 * These tests exist because the discriminator is the single thing standing between "the
 * network blipped" and "the database let it through", and it is invisible in a passing run.
 */
describe('the retry discriminator', () => {
  /** Builds the error object `pg` raises after PostgreSQL refuses a statement. */
  function serverRefusal(code: string, message: string): pg.DatabaseError {
    const error = new pg.DatabaseError(message, 0, 'error');
    error.code = code;
    return error;
  }

  describe('never retries anything the server answered', () => {
    const refusals: readonly (readonly [string, string, string])[] = [
      ['42501', 'permission denied for table sales', 'an RLS or grant denial'],
      ['23505', 'duplicate key value violates unique constraint', 'an idempotency claim'],
      ['23514', 'new row violates check constraint "sales_total_positive"', 'a CHECK'],
      ['23503', 'violates foreign key constraint', 'a foreign key'],
      ['P0001', 'INVALID_PRICE', 'a RAISE from a transactional RPC'],
      ['40001', 'could not serialize access due to concurrent update', 'a serialisation failure'],
      ['57014', 'canceling statement due to statement timeout', 'a statement timeout'],
    ];

    it.each(refusals)('%s — %s (%s)', (code, message) => {
      expect(isConnectionError(serverRefusal(code, message))).toBe(false);
    });

    it('refuses to retry even when the server message mentions the connection', () => {
      // The trap the old message-matching version would have fallen into: a refusal whose
      // text happens to contain a transport word. The server answered, so it is the answer.
      expect(
        isConnectionError(
          serverRefusal('42501', 'permission denied: connection terminated by policy'),
        ),
      ).toBe(false);
    });
  });

  describe('retries faults below the protocol, where the server never saw the statement', () => {
    const faults: readonly (readonly [string, string])[] = [
      ['ENOTFOUND', 'getaddrinfo ENOTFOUND aws-0-eu-west-2.pooler.supabase.com'],
      ['EADDRNOTAVAIL', 'read EADDRNOTAVAIL'],
      ['ECONNRESET', 'read ECONNRESET'],
      ['EPIPE', 'write EPIPE'],
      ['ETIMEDOUT', 'connect ETIMEDOUT'],
      ['ENETDOWN', 'connect ENETDOWN'],
    ];

    it.each(faults)('%s', (code, message) => {
      const error = Object.assign(new Error(message), { code });
      expect(isConnectionError(error)).toBe(true);
    });

    it('recognises the dead-client errors pg raises with no code at all', () => {
      // These arrive as plain Errors after the socket is already gone.
      expect(
        isConnectionError(
          new Error('Client has encountered a connection error and is not queryable'),
        ),
      ).toBe(true);
      expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    });
  });

  it('does not retry an unrecognised failure', () => {
    // The default is to let it through. An assertion error or a bug in the harness must
    // surface as itself, not be re-run until it looks intermittent.
    expect(isConnectionError(new Error('expected 850 to equal 849'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

/**
 * Opening a connection, when the network is not there.
 *
 * A `pg.Client` is single-use: once `connect()` has been called on one, even unsuccessfully,
 * calling it again throws "Client has already been connected. You cannot reuse a client."
 *
 * An earlier version of the retry helper reused the client, which was worse than having no
 * retry at all — a momentary network fault became a hard failure whose message described a
 * bug in the harness rather than the network. It cost ten tests across six suites in one
 * run of the real-PostgreSQL suite, and every one of them pointed at the wrong thing.
 */
describe('connecting with retries', () => {
  // A host that cannot resolve. Fails the same way a dropped network does, and fast.
  const UNREACHABLE = 'postgresql://user:pw@carl-no-such-host.invalid:5432/postgres';

  // Explicit timeouts: these deliberately exercise the backoff, which sleeps between
  // attempts, so they take longer than the suite's default.
  it('reports the real fault, not a reused-client error', async () => {
    await expect(connect(UNREACHABLE, 2)).rejects.toThrow(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i);
  }, 20_000);

  it('never reports that the client was already connected', async () => {
    // The exact regression, asserted on the message rather than through `.rejects.not`,
    // which does not mean what it looks like it means. If this string ever comes back, the
    // helper is reusing a client again and every transient blip is once more being
    // reported as a bug in the harness.
    const error = await connect(UNREACHABLE, 3).then(
      () => new Error('connect unexpectedly succeeded against an unreachable host'),
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/already been connected/i);
    expect((error as Error).message).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i);
  }, 30_000);

  it('gives up rather than retrying forever', async () => {
    // Bounded on purpose: a wrong host must fail while the person who typed it is watching.
    const started = Date.now();
    await expect(connect(UNREACHABLE, 2)).rejects.toThrow();
    // One backoff of ~2s between two attempts, and nothing like four attempts' worth.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
