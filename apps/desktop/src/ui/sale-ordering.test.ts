import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The order of operations when money changes hands.
 *
 * These assertions read the source rather than driving the component, because there is no
 * DOM test environment in this workspace and adding one is a larger change than the
 * invariant deserves. That is a real limitation: this proves the code is *shaped* correctly,
 * not that it *behaves* correctly. It is the same approach `hardware-security.test.ts` takes,
 * and it is the cheapest thing that catches the specific regression below.
 *
 * The regression: every step after the sale was queued — storing the receipt, printing,
 * firing the drawer, and `onCompleted`, which reads SQLite to refresh the pending count —
 * sat inside the same `try` as the enqueue. Any of them throwing produced
 *
 *     "The sale was not saved. Do not hand over the goods."
 *
 * while the sale was on disk and the cash was in the drawer. A cashier acting on that either
 * withholds goods the customer has paid for, or rings the sale a second time under a fresh
 * idempotency key and charges them twice. Idempotency does not save them: a new key is a
 * new sale.
 */
describe('the sale path', () => {
  const file = readFileSync(join(import.meta.dirname, 'payment-panel.tsx'), 'utf8');

  /*
   * The import block is deliberately excluded. Searching the whole file found
   * `printWithoutFailingTheSale` in its own import statement — above everything — and the
   * ordering assertions passed for a reason that had nothing to do with the order of the
   * sale. A test that can pass for the wrong reason is worse than no test.
   */
  const source = file.slice(file.indexOf('async function complete'));

  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    expect(index, `expected to find ${needle} in payment-panel.tsx`).toBeGreaterThan(-1);
    return index;
  };

  it('tells the cashier a sale failed only when the enqueue itself failed', () => {
    // The failure message must be reachable only from the enqueue's own catch, which
    // returns immediately rather than falling through to the rest of the sale.
    const message = at('The sale was not saved. Do not hand over the goods.');
    const enqueue = at('runtime.queue.enqueue');
    const printing = at('printWithoutFailingTheSale');

    expect(
      message,
      'the failure message must belong to the enqueue, not the whole flow',
    ).toBeGreaterThan(enqueue);
    expect(
      message,
      'the failure message appears after printing, so a print failure can reach it',
    ).toBeLessThan(printing);
  });

  it('stops rather than continuing when the sale was not saved', () => {
    // Without the early return, a failed enqueue would still print a receipt and open the
    // drawer for a sale that does not exist.
    const message = at('The sale was not saved. Do not hand over the goods.');
    const rest = source.slice(message);
    expect(rest.slice(0, 200)).toContain('return;');
  });

  it('prints only after the sale is on disk', () => {
    expect(at('runtime.queue.enqueue')).toBeLessThan(at('printWithoutFailingTheSale'));
  });

  it('opens the drawer only for cash', () => {
    const drawer = source.indexOf('openDrawer');
    const guard = source.lastIndexOf("method === 'CASH'", drawer);
    expect(guard, 'the drawer call is not guarded by a cash check').toBeGreaterThan(-1);
    expect(drawer - guard).toBeLessThan(400);
  });

  it('cannot leave a live Complete button over a sale that already happened', () => {
    // If clearing the screen fails, the panel settles: the only control left is Close.
    expect(source).toContain('setSettled(true)');
    const settled = at('{settled ? (');
    const complete = source.indexOf('void complete()');
    expect(settled, 'the Complete button must sit inside the not-settled branch').toBeLessThan(
      complete,
    );
  });

  it('reuses one idempotency key rather than generating one per attempt', () => {
    // A key generated inside a retry would make every retry a distinct sale.
    expect(source).toContain('crypto.randomUUID()');
    expect(at('crypto.randomUUID()')).toBeLessThan(at('runtime.queue.enqueue'));
  });
});
