import { describe, expect, it } from 'vitest';
import pg from 'pg';

import { isConnectionError } from '../support/pg-database.js';

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
    const refusals: ReadonlyArray<readonly [string, string, string]> = [
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
    const faults: ReadonlyArray<readonly [string, string]> = [
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
