import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@carl/shared';

import { SyncEngine } from '../engine';
import { InMemorySyncQueue } from '../memory-queue';
import { SyncState, type QueuedOperation, type SyncOutcome, type SyncTransport } from '../ports';
import { NodeSqliteConnection } from './node-sqlite-adapter';
import { SqliteSyncQueue } from './sqlite-queue';

/**
 * The durable queue.
 *
 * This is the implementation that actually holds a shop's money, so it is held to the same
 * contract as the in-memory reference and exercised by the same engine. Where the two
 * disagree, one of them is wrong about a sale.
 *
 * Run against Node's built-in SQLite rather than only inside a compiled desktop binary,
 * because a queue that can only be tested by building a Tauri app is a queue nobody tests.
 */
describe('SqliteSyncQueue', () => {
  let connection: NodeSqliteConnection;
  let queue: SqliteSyncQueue;
  let clock: ReturnType<typeof fixedClock>;

  beforeEach(async () => {
    connection = new NodeSqliteConnection(':memory:');
    queue = new SqliteSyncQueue(connection);
    await queue.migrate();
    clock = fixedClock('2026-03-01T09:00:00.000Z');
  });

  async function queueSale(id: string, occurredAt: string): Promise<void> {
    await queue.enqueue({
      id,
      operation: 'complete_sale',
      payload: { branch_id: 'b1', items: [{ product_id: 'p1', quantity: 1 }] },
      occurredAt,
    } as never);
  }

  function transport(
    respond: (operation: QueuedOperation) => SyncOutcome,
    online = true,
  ): SyncTransport & { calls: QueuedOperation[]; online: boolean } {
    const calls: QueuedOperation[] = [];
    return {
      calls,
      online,
      isOnline() {
        return this.online;
      },
      submit(operation) {
        calls.push(operation);
        return Promise.resolve(respond(operation));
      },
    };
  }

  describe('the contract', () => {
    it('is idempotent on enqueue, so a crash-and-retry cannot duplicate a sale', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      expect(await queue.all()).toHaveLength(1);
    });

    it('round-trips the payload intact', async () => {
      // The payload is the sale. If it does not survive storage, nothing else matters.
      await queue.enqueue({
        id: 'op-payload',
        operation: 'complete_sale',
        payload: {
          branch_id: 'b1',
          items: [{ product_id: 'p1', quantity: 1.5, discount_type: 'PERCENTAGE', discount_value: 12.5 }],
          payments: [{ method: 'MOMO', amount: 12345, reference: 'MM-99' }],
        },
        occurredAt: '2026-03-01T08:00:00.000Z',
      } as never);

      const stored = await queue.get('op-payload');
      expect(stored?.payload).toEqual({
        branch_id: 'b1',
        items: [
          { product_id: 'p1', quantity: 1.5, discount_type: 'PERCENTAGE', discount_value: 12.5 },
        ],
        payments: [{ method: 'MOMO', amount: 12345, reference: 'MM-99' }],
      });
    });

    it('claims oldest first, by when the sale happened', async () => {
      await queueSale('late', '2026-03-01T08:30:00.000Z');
      await queueSale('early', '2026-03-01T07:00:00.000Z');
      await queueSale('middle', '2026-03-01T08:00:00.000Z');

      const batch = await queue.claimBatch(10, clock.now());
      expect(batch.map((o) => o.id)).toEqual(['early', 'middle', 'late']);
    });

    it('does not claim an operation before its retry time', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queue.markFailed('op-1', null, 'Timeout', new Date('2026-03-01T09:05:00.000Z'), clock.now());

      expect(await queue.claimBatch(10, clock.now())).toHaveLength(0);
      clock.set('2026-03-01T09:06:00.000Z');
      expect(await queue.claimBatch(10, clock.now())).toHaveLength(1);
    });

    it('never claims a conflict or an abandoned operation', async () => {
      await queueSale('conflicted', '2026-03-01T08:00:00.000Z');
      await queueSale('abandoned', '2026-03-01T08:01:00.000Z');
      await queue.markConflict('conflicted', 'c1', 'Insufficient stock', clock.now());
      await queue.markAbandoned('abandoned', 'Gave up', clock.now());

      clock.advance(24 * 60 * 60_000);
      expect(await queue.claimBatch(10, clock.now())).toHaveLength(0);
    });

    it('surfaces conflicts and abandoned operations for a human', async () => {
      await queueSale('a', '2026-03-01T08:00:00.000Z');
      await queueSale('b', '2026-03-01T08:01:00.000Z');
      await queueSale('c', '2026-03-01T08:02:00.000Z');
      await queue.markConflict('a', 'c1', 'Insufficient stock', clock.now());
      await queue.markAbandoned('b', 'Gave up', clock.now());
      await queue.markSynced('c', 'sale-1', clock.now());

      const attention = await queue.needingAttention();
      expect(attention.map((o) => o.id).sort()).toEqual(['a', 'b']);
    });

    it('counts by state', async () => {
      await queueSale('a', '2026-03-01T08:00:00.000Z');
      await queueSale('b', '2026-03-01T08:01:00.000Z');
      await queue.markSynced('a', 'r', clock.now());

      const counts = await queue.counts();
      expect(counts[SyncState.SYNCED]).toBe(1);
      expect(counts[SyncState.PENDING]).toBe(1);
    });
  });

  describe('durability', () => {
    it('survives closing and reopening the database', async () => {
      // The property the whole implementation exists for: a sale written before a crash is
      // still there afterwards.
      const path = `/tmp/carl-queue-test-${Date.now()}.db`;
      const first = new NodeSqliteConnection(path);
      const persisted = new SqliteSyncQueue(first);
      await persisted.migrate();
      await persisted.enqueue({
        id: 'survives-restart',
        operation: 'complete_sale',
        payload: { total: 12345 },
        occurredAt: '2026-03-01T08:00:00.000Z',
      } as never);
      first.close();

      const second = new NodeSqliteConnection(path);
      const reopened = new SqliteSyncQueue(second);
      await reopened.migrate(); // idempotent, as a terminal runs it on every start

      const recovered = await reopened.get('survives-restart');
      expect(recovered?.state).toBe(SyncState.PENDING);
      expect(recovered?.payload).toEqual({ total: 12345 });
      second.close();
    });

    it('rejects an unknown state at the database level', async () => {
      // A CHECK rather than trust: a corrupted state would make the engine skip a sale.
      await expect(
        connection.execute(
          `insert into sync_queue (id, operation, payload, state, occurred_at)
           values ('bad', 'complete_sale', '{}', 'NONSENSE', '2026-03-01T08:00:00.000Z')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('pruning', () => {
    it('removes only confirmed operations, and only old ones', async () => {
      await queueSale('old-synced', '2026-01-01T08:00:00.000Z');
      await queueSale('recent-synced', '2026-03-01T08:00:00.000Z');
      await queueSale('old-conflict', '2026-01-01T08:00:00.000Z');

      await queue.markSynced('old-synced', 'r1', new Date('2026-01-01T09:00:00.000Z'));
      await queue.markSynced('recent-synced', 'r2', new Date('2026-03-01T09:00:00.000Z'));
      await queue.markConflict('old-conflict', 'c1', 'Stock', new Date('2026-01-01T09:00:00.000Z'));

      const removed = await queue.prune(new Date('2026-02-01T00:00:00.000Z'));

      expect(removed).toBe(1);
      expect(await queue.get('old-synced')).toBeUndefined();
      expect(await queue.get('recent-synced')).toBeDefined();
      // A conflict is never pruned: someone still has to deal with it.
      expect(await queue.get('old-conflict'), 'an unresolved conflict was pruned').toBeDefined();
    });
  });

  describe('equivalence with the in-memory reference', () => {
    /**
     * Drives both implementations through the same engine and the same transport, then
     * compares the resulting state. The in-memory queue is what the engine's own tests are
     * written against; if the durable one behaves differently, one of them is wrong about
     * a sale — and it is the durable one that holds real money.
     */
    async function driveBoth(
      respond: (operation: QueuedOperation) => SyncOutcome,
      runs = 3,
    ): Promise<{ sqlite: QueuedOperation[]; memory: QueuedOperation[] }> {
      const memory = new InMemorySyncQueue();
      const sqliteClock = fixedClock('2026-03-01T09:00:00.000Z');
      const memoryClock = fixedClock('2026-03-01T09:00:00.000Z');

      for (const [index, occurredAt] of [
        '2026-03-01T08:00:00.000Z',
        '2026-03-01T08:01:00.000Z',
        '2026-03-01T08:02:00.000Z',
      ].entries()) {
        const entry = {
          id: `op-${index}`,
          operation: 'complete_sale' as const,
          payload: { n: index },
          occurredAt,
        };
        await queue.enqueue(entry);
        await memory.enqueue(entry);
      }

      const sqliteEngine = new SyncEngine({
        queue,
        transport: transport(respond),
        clock: sqliteClock,
        maxAttempts: 3,
      });
      const memoryEngine = new SyncEngine({
        queue: memory,
        transport: transport(respond),
        clock: memoryClock,
        maxAttempts: 3,
      });

      for (let i = 0; i < runs; i += 1) {
        await sqliteEngine.run();
        await memoryEngine.run();
        sqliteClock.advance(10 * 60_000);
        memoryClock.advance(10 * 60_000);
      }

      return { sqlite: await queue.all(), memory: memory.all() };
    }

    /** Compares only what the engine decides, not timestamps the two clocks assign. */
    const shape = (operations: QueuedOperation[]) =>
      [...operations]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((o) => ({ id: o.id, state: o.state, attempts: o.attempts, remoteId: o.remoteId }));

    it('agrees when everything succeeds', async () => {
      const { sqlite, memory } = await driveBoth(() => ({
        kind: 'accepted',
        remoteId: 'sale-x',
        replayed: false,
      }));
      expect(shape(sqlite)).toEqual(shape(memory));
      expect(sqlite.every((o) => o.state === SyncState.SYNCED)).toBe(true);
    });

    it('agrees when the server conflicts', async () => {
      const { sqlite, memory } = await driveBoth((operation) =>
        operation.id === 'op-1'
          ? { kind: 'conflict', conflictId: 'c1', detail: 'Insufficient stock' }
          : { kind: 'accepted', remoteId: 'r', replayed: false },
      );
      expect(shape(sqlite)).toEqual(shape(memory));
    });

    it('agrees when operations are abandoned after repeated failure', async () => {
      const { sqlite, memory } = await driveBoth(
        () => ({ kind: 'retryable', code: null, detail: 'Server error' }),
        4,
      );
      expect(shape(sqlite)).toEqual(shape(memory));
      expect(sqlite.every((o) => o.state === SyncState.ABANDONED)).toBe(true);
      // Abandoned still means kept.
      expect(sqlite).toHaveLength(3);
    });

    it('agrees when the terminal is revoked mid-run', async () => {
      const { sqlite, memory } = await driveBoth(() => ({
        kind: 'unauthorized',
        code: 'DEVICE_REVOKED',
        detail: 'Revoked',
      }));
      expect(shape(sqlite)).toEqual(shape(memory));
    });
  });
});
