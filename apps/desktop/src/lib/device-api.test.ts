import { describe, expect, it, vi } from 'vitest';

import { DeviceApi } from './device-api';

/**
 * How the terminal classifies what the server said.
 *
 * This mapping decides whether a sale is retried, parked for a person, or stops the
 * terminal entirely. Get it wrong in one direction and a real sale is dropped; wrong in
 * the other and a revoked till hammers the server forever. Neither is visible in a
 * passing shop day, which is why it is pinned here.
 */
describe('DeviceApi', () => {
  const credential = {
    deviceId: 'd1',
    deviceSecret: 'x'.repeat(64),
    // The cashier's token. A sale is attributed to a person, so the terminal's own
    // credential is necessary and not sufficient.
    accessToken: 'y'.repeat(40),
  };

  /** A fetch that answers with one prepared response. */
  function respondWith(status: number, body: unknown): typeof globalThis.fetch {
    return vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  function api(fetchImpl: typeof globalThis.fetch): DeviceApi {
    return new DeviceApi({ baseUrl: 'https://carl.example', fetch: fetchImpl });
  }

  describe('a sale that reached the server', () => {
    it('is accepted', async () => {
      const outcome = await api(
        respondWith(200, { saleId: 'sale-1', replayed: false, hadConflict: false }),
      ).submitSale(credential, {});

      expect(outcome).toEqual({ kind: 'accepted', remoteId: 'sale-1', replayed: false });
    });

    it('reports a replay as a replay', async () => {
      // The terminal resent a sale whose response was lost. It is the same sale, not a
      // second one — and the difference is what a shop asks about when the day's takings
      // do not match the till's own count.
      const outcome = await api(
        respondWith(200, { saleId: 'sale-1', replayed: true, hadConflict: false }),
      ).submitSale(credential, {});

      expect(outcome).toEqual({ kind: 'accepted', remoteId: 'sale-1', replayed: true });
    });

    it('reports a recorded sale that disagrees with stock as a conflict', async () => {
      // Two terminals sold the same last unit while offline. Both took money, so the sale
      // is recorded — but reporting it as plainly accepted would hide the discrepancy
      // until someone counted the shelf.
      const outcome = await api(
        respondWith(200, {
          saleId: 'sale-2',
          replayed: false,
          hadConflict: true,
          conflictId: 'c-9',
        }),
      ).submitSale(credential, {});

      expect(outcome.kind).toBe('conflict');
      expect(outcome).toMatchObject({ conflictId: 'c-9' });
    });
  });

  describe('a terminal that must stop', () => {
    it.each([
      ['DEVICE_REVOKED', 403],
      ['DEVICE_NOT_ACTIVATED', 401],
      ['DEVICE_NOT_FOUND', 401],
      ['DEVICE_AUTHORIZATION_EXPIRED', 403],
      ['TENANT_SUSPENDED', 403],
    ])('stops on %s', async (error, status) => {
      const outcome = await api(
        respondWith(status, { error, detail: error, retryable: false }),
      ).submitSale(credential, {});

      expect(outcome).toEqual({ kind: 'unauthorized', code: error, detail: error });
    });
  });

  describe('a sale that has not landed yet', () => {
    it('retries a server error', async () => {
      const outcome = await api(
        respondWith(500, { error: 'INTERNAL', detail: 'boom', retryable: true }),
      ).submitSale(credential, {});

      expect(outcome.kind).toBe('retryable');
    });

    it('retries when the request never reached the server', async () => {
      const failing = vi.fn(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      ) as unknown as typeof globalThis.fetch;

      const outcome = await api(failing).submitSale(credential, {});

      expect(outcome).toMatchObject({ kind: 'retryable', code: 'NETWORK' });
    });

    it('gives up on a request that hangs', async () => {
      // A cashier is standing there. The sale is already safe on disk, so abandoning the
      // attempt costs nothing and retrying later costs nothing either.
      const hanging = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;

      const outcome = await new DeviceApi({
        baseUrl: 'https://carl.example',
        fetch: hanging,
        timeoutMs: 20,
      }).submitSale(credential, {});

      expect(outcome).toMatchObject({ kind: 'retryable', code: 'NETWORK' });
    });

    it('keeps a sale the server refuses rather than discarding it', async () => {
      // A 422 will never succeed as-is. It is still reported as retryable so the engine
      // abandons it after its attempt limit and surfaces it for a person — because a sale
      // that really happened, and for which money was really taken, is not Carl's to
      // decide never happened.
      const outcome = await api(
        respondWith(422, { error: 'INVALID_PRICE', detail: 'no price', retryable: false }),
      ).submitSale(credential, {});

      expect(outcome).toMatchObject({ kind: 'retryable', code: 'INVALID_PRICE' });
    });

    it('treats an error response that is not JSON as a server problem', async () => {
      const html = vi.fn(() =>
        Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
      ) as unknown as typeof globalThis.fetch;

      // A proxy returning an HTML error page must not look like a refusal from Carl.
      const outcome = await api(html).submitSale(credential, {});
      expect(outcome).toMatchObject({ kind: 'retryable', code: 'HTTP_502' });
    });
  });

  describe('what it sends', () => {
    it('never puts the device secret in the URL', async () => {
      // A secret in a query string is a secret in every proxy log between here and the
      // server.
      const spy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ saleId: 's', replayed: false, hadConflict: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      await api(spy).submitSale(credential, {});

      const call = spy.mock.calls[0];
      // A string in practice; narrowed rather than stringified so a URL object could not
      // quietly pass this test as "[object Object]".
      const url = typeof call?.[0] === 'string' ? call[0] : '';
      const body = typeof call?.[1]?.body === 'string' ? call[1].body : '';
      expect(url).toBe('https://carl.example/api/device/sync');
      expect(url).not.toContain(credential.deviceSecret);
      expect(url).not.toContain(credential.accessToken);
      expect(body).toContain(credential.deviceSecret);
      expect(body).toContain(credential.accessToken);
    });
  });
});
