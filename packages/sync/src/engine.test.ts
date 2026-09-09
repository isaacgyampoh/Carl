import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@carl/shared';

import { SyncEngine } from './engine';
import { InMemorySyncQueue } from './memory-queue';
import { retryDelayMs } from './backoff';
import { type QueuedOperation, SyncState, type SyncOutcome, type SyncTransport } from './ports';

/**
 * The sync engine.
 *
 * Its contract is one sentence: **no queued transaction is ever silently discarded.**
 * Every operation ends up accepted, raised as a conflict for a human, or set aside as
 * abandoned — and abandoned still means kept. A sale that cannot be synced still happened;
 * the customer paid and left with the goods, and deleting the row does not undo that.
 *
 * Most of these tests exist to pin that down under the conditions where queues usually
 * lose things: a connection that drops mid-batch, a server that keeps failing, a terminal
 * revoked while its queue is still draining.
 */
describe('sync engine', () => {
  let queue: InMemorySyncQueue;
  let clock: ReturnType<typeof fixedClock>;

  beforeEach(() => {
    queue = new InMemorySyncQueue();
    clock = fixedClock('2026-03-01T09:00:00.000Z');
  });

  /** A transport whose verdicts the test controls. */
  function transport(
    respond: (operation: QueuedOperation) => SyncOutcome | Promise<SyncOutcome>,
    online = true,
  ): SyncTransport & { calls: QueuedOperation[]; online: boolean } {
    const calls: QueuedOperation[] = [];
    return {
      calls,
      online,
      isOnline() {
        return this.online;
      },
      async submit(operation) {
        calls.push(operation);
        return respond(operation);
      },
    };
  }

  async function queueSale(id: string, occurredAt: string): Promise<void> {
    await queue.enqueue({
      id,
      operation: 'complete_sale',
      payload: { branch_id: 'b1', items: [{ product_id: 'p1', quantity: 1 }] },
      occurredAt,
      remoteId: null,
      conflictId: null,
    } as never);
  }

  describe('draining the queue', () => {
    it('submits pending operations and marks them synced', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-2', '2026-03-01T08:05:00.000Z');

      const net = transport(() => ({ kind: 'accepted', remoteId: 'sale-x', replayed: false }));
      const engine = new SyncEngine({ queue, transport: net, clock });

      const result = await engine.run();

      expect(result.status).toBe('completed');
      expect(net.calls).toHaveLength(2);
      expect(queue.get('op-1')?.state).toBe(SyncState.SYNCED);
      expect(queue.get('op-1')?.remoteId).toBe('sale-x');
    });

    it('submits in the order the sales actually happened', async () => {
      // Sales apply against a running stock balance, so replaying them out of order
      // produces a different — and wrong — sequence of ledger balances.
      await queueSale('op-late', '2026-03-01T08:30:00.000Z');
      await queueSale('op-early', '2026-03-01T07:00:00.000Z');
      await queueSale('op-middle', '2026-03-01T08:00:00.000Z');

      const net = transport(() => ({ kind: 'accepted', remoteId: 'r', replayed: false }));
      await new SyncEngine({ queue, transport: net, clock }).run();

      expect(net.calls.map((c) => c.id)).toEqual(['op-early', 'op-middle', 'op-late']);
    });

    it('does nothing when offline', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      const net = transport(() => ({ kind: 'accepted', remoteId: 'r', replayed: false }), false);

      const result = await new SyncEngine({ queue, transport: net, clock }).run();

      expect(result).toEqual({ status: 'idle', reason: 'offline' });
      expect(net.calls).toHaveLength(0);
      expect(queue.get('op-1')?.state).toBe(SyncState.PENDING);
    });

    it('reports an empty queue as idle rather than as work done', async () => {
      const net = transport(() => ({ kind: 'accepted', remoteId: 'r', replayed: false }));
      expect(await new SyncEngine({ queue, transport: net, clock }).run()).toEqual({
        status: 'idle',
        reason: 'empty',
      });
    });

    it('stops mid-batch when the connection drops, leaving the rest queued', async () => {
      // A dropped connection must not burn an attempt on every remaining operation.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-2', '2026-03-01T08:01:00.000Z');
      await queueSale('op-3', '2026-03-01T08:02:00.000Z');

      const net = transport((operation) => {
        if (operation.id === 'op-1') net.online = false;
        return { kind: 'accepted', remoteId: 'r', replayed: false };
      });

      await new SyncEngine({ queue, transport: net, clock }).run();

      expect(net.calls).toHaveLength(1);
      expect(queue.get('op-2')?.state).toBe(SyncState.PENDING);
      expect(queue.get('op-2')?.attempts).toBe(0);
      expect(queue.get('op-3')?.state).toBe(SyncState.PENDING);
    });

    it('respects the batch size, leaving the remainder for the next run', async () => {
      for (let i = 0; i < 10; i += 1) {
        await queueSale(`op-${i}`, `2026-03-01T08:0${i}:00.000Z`);
      }
      const net = transport(() => ({ kind: 'accepted', remoteId: 'r', replayed: false }));

      const result = await new SyncEngine({ queue, transport: net, clock, batchSize: 3 }).run();

      expect(net.calls).toHaveLength(3);
      expect(result.status === 'completed' && result.progress.remaining).toBe(7);
    });
  });

  describe('conflicts', () => {
    it('records a conflict and never retries it', async () => {
      // The server declined on business grounds. Retrying cannot change that, and retrying
      // forever turns a queue into a loop.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      const net = transport(() => ({
        kind: 'conflict',
        conflictId: 'conf-1',
        detail: 'Requested 7 but only 2 available.',
      }));
      const engine = new SyncEngine({ queue, transport: net, clock });

      await engine.run();
      expect(queue.get('op-1')?.state).toBe(SyncState.CONFLICT);
      expect(queue.get('op-1')?.conflictId).toBe('conf-1');

      // A second run must not pick it up again.
      clock.advance(60 * 60_000);
      await engine.run();
      expect(net.calls).toHaveLength(1);
    });

    it('surfaces conflicts for a human', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-2', '2026-03-01T08:01:00.000Z');

      const net = transport((operation) =>
        operation.id === 'op-1'
          ? { kind: 'conflict', conflictId: 'c1', detail: 'Insufficient stock' }
          : { kind: 'accepted', remoteId: 'r', replayed: false },
      );

      await new SyncEngine({ queue, transport: net, clock }).run();

      const attention = await queue.needingAttention();
      expect(attention.map((row) => row.id)).toEqual(['op-1']);
    });

    it('keeps draining the rest of the batch after one conflicts', async () => {
      // One bad sale must not block the shop's other transactions from reaching the server.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-2', '2026-03-01T08:01:00.000Z');
      await queueSale('op-3', '2026-03-01T08:02:00.000Z');

      const net = transport((operation) =>
        operation.id === 'op-2'
          ? { kind: 'conflict', conflictId: 'c', detail: 'Insufficient stock' }
          : { kind: 'accepted', remoteId: 'r', replayed: false },
      );

      const result = await new SyncEngine({ queue, transport: net, clock }).run();

      expect(net.calls).toHaveLength(3);
      expect(result.status === 'completed' && result.progress).toMatchObject({
        accepted: 2,
        conflicted: 1,
      });
    });
  });

  describe('retries', () => {
    it('schedules a retry after a transient failure', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      const net = transport(() => ({ kind: 'retryable', code: null, detail: 'Network timeout' }));
      await new SyncEngine({ queue, transport: net, clock }).run();

      const row = queue.get('op-1');
      expect(row?.state).toBe(SyncState.FAILED);
      expect(row?.attempts).toBe(1);
      expect(row?.nextAttemptAt).not.toBeNull();
    });

    it('does not retry before the scheduled time', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      const net = transport(() => ({ kind: 'retryable', code: null, detail: 'Timeout' }));
      const engine = new SyncEngine({ queue, transport: net, clock });

      await engine.run();
      const scheduled = queue.get('op-1')!.nextAttemptAt!;

      // Immediately after: not yet due.
      await engine.run();
      expect(net.calls).toHaveLength(1);

      // Past the scheduled time: due.
      clock.set(new Date(new Date(scheduled).getTime() + 1000));
      await engine.run();
      expect(net.calls).toHaveLength(2);
    });

    it('treats a thrown transport error as retryable, not as a verdict', async () => {
      // A network failure is not the server saying no. The operation may well have
      // arrived, and the idempotency key makes re-sending it safe.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      const net = transport(() => {
        throw new Error('fetch failed');
      });
      await new SyncEngine({ queue, transport: net, clock }).run();

      expect(queue.get('op-1')?.state).toBe(SyncState.FAILED);
      expect(queue.get('op-1')?.lastError).toContain('fetch failed');
    });

    it('sets an operation aside after repeated failures rather than deleting it', async () => {
      // The sale happened. Deleting the record does not un-sell the goods.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      const net = transport(() => ({ kind: 'retryable', code: null, detail: 'Server error' }));
      const engine = new SyncEngine({ queue, transport: net, clock, maxAttempts: 3 });

      for (let i = 0; i < 3; i += 1) {
        await engine.run();
        clock.advance(10 * 60_000);
      }

      const row = queue.get('op-1');
      expect(row?.state).toBe(SyncState.ABANDONED);
      expect(row, 'the operation was deleted rather than set aside').toBeDefined();
      expect(row?.lastError).toContain('after 3 attempts');

      const attention = await queue.needingAttention();
      expect(attention.map((r) => r.id)).toContain('op-1');
    });

    it('stops retrying an abandoned operation', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      const net = transport(() => ({ kind: 'retryable', code: null, detail: 'Server error' }));
      const engine = new SyncEngine({ queue, transport: net, clock, maxAttempts: 2 });

      for (let i = 0; i < 4; i += 1) {
        await engine.run();
        clock.advance(10 * 60_000);
      }

      // Two attempts, then abandoned and left alone.
      expect(net.calls).toHaveLength(2);
    });
  });

  describe('authorisation', () => {
    it('halts the whole run when the terminal is revoked', async () => {
      // Nothing else in the queue can succeed either, so continuing would burn an attempt
      // on every remaining operation for no reason.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-2', '2026-03-01T08:01:00.000Z');
      await queueSale('op-3', '2026-03-01T08:02:00.000Z');

      const net = transport(() => ({
        kind: 'unauthorized',
        code: 'DEVICE_REVOKED',
        detail: 'This terminal has been revoked.',
      }));

      const result = await new SyncEngine({ queue, transport: net, clock }).run();

      expect(result.status).toBe('halted');
      expect(result.status === 'halted' && result.code).toBe('DEVICE_REVOKED');
      expect(net.calls, 'the run continued past a revoked terminal').toHaveLength(1);
      expect(queue.get('op-2')?.state).toBe(SyncState.PENDING);
    });

    it('halts on a suspended tenant', async () => {
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      const net = transport(() => ({
        kind: 'unauthorized',
        code: 'TENANT_SUSPENDED',
        detail: 'This account is suspended.',
      }));

      const result = await new SyncEngine({ queue, transport: net, clock }).run();
      expect(result.status === 'halted' && result.code).toBe('TENANT_SUSPENDED');
    });
  });

  describe('replays', () => {
    it('accepts a replayed operation as successfully synced', async () => {
      // The terminal could not know the server had already accepted this. It has, and the
      // queue must record it as done rather than retrying forever.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      const net = transport(() => ({ kind: 'accepted', remoteId: 'sale-1', replayed: true }));
      await new SyncEngine({ queue, transport: net, clock }).run();

      expect(queue.get('op-1')?.state).toBe(SyncState.SYNCED);
      expect(queue.get('op-1')?.remoteId).toBe('sale-1');
    });

    it('ignores a re-enqueued id rather than duplicating it', async () => {
      // A terminal that crashes between writing a sale locally and marking it queued will
      // retry the enqueue on restart.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      expect(queue.all()).toHaveLength(1);
    });
  });

  describe('concurrent runs', () => {
    it('does not start a second run while one is in progress', async () => {
      // A reconnect event and the periodic timer routinely fire together. Two runs would
      // both claim the same operations — harmless because writes are idempotent, but it
      // wastes a poor connection and makes the progress figures wrong.
      await queueSale('op-1', '2026-03-01T08:00:00.000Z');

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const net = transport(async () => {
        await gate;
        return { kind: 'accepted', remoteId: 'r', replayed: false };
      });
      const engine = new SyncEngine({ queue, transport: net, clock });

      const first = engine.run();
      const second = await engine.run();

      expect(second).toEqual({ status: 'idle', reason: 'empty' });
      release();
      await first;
      expect(net.calls).toHaveLength(1);
    });
  });

  describe('progress reporting', () => {
    it('reports what happened and what is left', async () => {
      for (let i = 0; i < 5; i += 1) {
        await queueSale(`op-${i}`, `2026-03-01T08:0${i}:00.000Z`);
      }

      const net = transport((operation) =>
        operation.id === 'op-2'
          ? { kind: 'conflict', conflictId: 'c', detail: 'Insufficient stock' }
          : { kind: 'accepted', remoteId: 'r', replayed: false },
      );

      const onProgress = vi.fn();
      const result = await new SyncEngine({ queue, transport: net, clock, onProgress }).run();

      expect(result.status === 'completed' && result.progress).toEqual({
        attempted: 5,
        accepted: 4,
        conflicted: 1,
        failed: 0,
        remaining: 0,
      });
      expect(onProgress).toHaveBeenCalledOnce();
    });
  });
});

describe('retry backoff', () => {
  it('grows with each attempt', () => {
    // Fixed at the top of the jitter range so the growth itself is what is measured.
    const ceiling = () => 0.999999;
    const delays = [1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, ceiling));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('is capped, so an overnight outage does not delay the morning', () => {
    expect(retryDelayMs(50, () => 0.999999)).toBeLessThanOrEqual(5 * 60_000);
  });

  it('is jittered, so a branch of terminals does not retry in lockstep', () => {
    // Every till in a shop loses the connection together and recovers together. Without
    // jitter they would all hit the server at the same instants, fail together, and line
    // up to do it again.
    const delays = new Set(Array.from({ length: 50 }, () => retryDelayMs(5, Math.random)));
    expect(delays.size).toBeGreaterThan(20);
  });

  it('never returns a negative delay', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(retryDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });
});
