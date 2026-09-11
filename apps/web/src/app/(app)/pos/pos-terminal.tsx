'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Cart,
  DiscountKind,
  EMPTY_CART,
  addToCart,
  cartTotals,
  clearCart,
  insufficientLines,
  lineTotals,
  removeFromCart,
  toSalePayload,
  updateQuantity,
  type ReceiptData,
} from '@carl/domain';
import { formatMoney, formatQuantity, newIdempotencyKey } from '@carl/shared';
import { Alert, Button, cn } from '@carl/ui';

import { PAYMENT_METHOD_LABEL } from '@/components/receipt';
import { completeSale, searchProducts, type SearchResult } from '@/server/pos-actions';
import { PaymentPanel } from './payment-panel';
import { ReceiptDialog } from './receipt-dialog';

/**
 * The till.
 *
 * ## What this screen optimises for
 *
 * A cashier stands at this for eight hours with a queue in front of them. Every decision
 * here follows from that:
 *
 *   - The search box holds focus permanently. A barcode scanner is a keyboard, so a scan
 *     only works if something is listening; anything that steals focus breaks scanning
 *     silently, and the cashier discovers it mid-transaction.
 *   - The cart total is computed locally and updates on the same frame as the scan. A
 *     round trip per item would make the till feel broken. The server re-derives it at
 *     checkout, and a test asserts the two agree to the pesewa.
 *   - Keyboard shortcuts cover the whole flow, because reaching for a mouse between
 *     every customer costs more than it looks like it does.
 *   - No confirmation dialogs on the hot path. A cashier who has to dismiss something on
 *     every sale stops reading it by the second hour.
 */
export function PosTerminal({
  branchId,
  branchName,
  cashierName,
  canDiscount,
  canSellWholesale,
  receiptHeader,
}: {
  branchId: string;
  branchName: string;
  cashierName: string;
  canDiscount: boolean;
  canSellWholesale: boolean;
  /** What the business's receipts say about it, from Settings. */
  receiptHeader: {
    businessName: string;
    addressLines: string[];
    phone: string | null;
    taxId: string | null;
    footer: string | null;
    currencyCode: string;
  };
}) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<{
    saleNumber: string;
    total: number;
    paid: number;
    change: number;
    print: ReceiptData;
  } | null>(null);

  // Phones only: the basket is a sheet over the search rather than a column beside it.
  const [basketOpen, setBasketOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  /*
   * Whether this till is worked from a keyboard or scanner rather than a finger.
   *
   * Decided once on mount. On a touch-only screen, focusing the search field raises the
   * on-screen keyboard over half the till after every tap; there, a scanner's keystrokes are
   * routed into the search by the key listener instead.
   */
  const keyboardFirst = useRef(true);
  /*
   * The idempotency key for the sale currently being paid for, held across retries.
   *
   * A ref rather than state because changing it must not re-render the till mid-payment,
   * and because every read of it happens inside the submit handler.
   */
  const saleKey = useRef<string | null>(null);

  /*
   * Opening and closing the payment panel is what bounds a sale's identity.
   *
   * The key must survive a retry of the SAME sale and must not survive anything else. If a
   * cancelled panel left its key behind, the next sale rung up would carry it — and if the
   * first attempt had in fact reached the server, the second would be discarded as a
   * duplicate. The customer pays and nothing is recorded, which is worse than the double
   * charge this whole mechanism exists to prevent.
   */
  const openPayment = useCallback(() => {
    saleKey.current = null;
    setPaying(true);
  }, []);

  const closePayment = useCallback(() => {
    saleKey.current = null;
    setPaying(false);
  }, []);
  const totals = cartTotals(cart);
  const short = insufficientLines(cart);

  /**
   * Returns focus to the search box.
   *
   * Called after every action that could have moved it. A scanner types into whatever has
   * focus, so this is what keeps scanning working at all.
   */
  const focusSearch = useCallback((force = false) => {
    if (!force && !keyboardFirst.current) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const addProduct = useCallback(
    (result: SearchResult) => {
      setCart((current) =>
        addToCart(current, {
          productId: result.productId,
          name: result.name,
          sku: result.sku,
          unit: result.unit,
          unitPrice: result.unitPrice,
          // A case barcode adds its whole pack, not one unit.
          quantity: Math.round(result.packSize * 1000),
          taxMode: 'EXEMPT',
          taxRate: 0,
          allowFractional: false,
          available: Math.round(result.quantity * 1000),
        }),
      );
      setQuery('');
      setResults([]);
      setError(null);
      focusSearch();
    },
    [focusSearch],
  );

  // Search, debounced. An exact barcode match is added straight to the cart without the
  // cashier choosing from a list — that is the entire point of a scanner.
  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      setSearching(true);
      searchProducts({ branchId, query: term, tier: cart.tier, limit: 20 })
        .then((result) => {
          if (!result.ok) {
            setError(result.message);
            setResults([]);
            return;
          }
          const exact = result.data.find((r) => r.isExact);
          if (exact) {
            addProduct(exact);
          } else {
            setResults(result.data);
          }
        })
        .catch(() => {
          /*
           * Clearing is the safe failure, not keeping what was there.
           *
           * A rejected search never called setResults, so the list went on showing matches
           * for whatever was typed before. A cashier typing a new product and clicking the
           * first row would have added the previous customer's item at the previous
           * customer's price.
           */
          setResults([]);
          setError('Product search is not responding. Check the connection and try again.');
        })
        .finally(() => setSearching(false));
    }, 120);

    return () => clearTimeout(timer);
  }, [query, branchId, cart.tier, addProduct]);

  // Shortcuts. F-keys rather than letter combinations, so they cannot collide with a
  // barcode being typed into the search field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      // Printable keys with nothing focused (a scanner, or a keyboard after tapping the
      // basket) belong to the search. A touch till leaves the field unfocused on purpose.
      if (
        !typing &&
        !paying &&
        !receipt &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setQuery((current) => current + event.key);
        return;
      }

      if (event.key === 'F2') {
        event.preventDefault();
        focusSearch(true);
      } else if (event.key === 'F4' && cart.lines.length > 0) {
        event.preventDefault();
        openPayment();
      } else if (event.key === 'Escape') {
        closePayment();
        setBasketOpen(false);
        focusSearch();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cart.lines.length, focusSearch, openPayment, closePayment, paying, receipt]);

  useEffect(() => {
    keyboardFirst.current =
      window.matchMedia('(any-pointer: fine)').matches ||
      !window.matchMedia('(pointer: coarse)').matches;
    focusSearch();
  }, [focusSearch]);

  async function onPay(payments: { method: string; amount: number; reference?: string }[]) {
    setError(null);

    /*
     * ONE key for this logical sale, reused by every attempt at it.
     *
     * It used to be generated inside this function, which runs once per press of Confirm.
     * So the second press was a different key and therefore a different sale — the exact
     * thing idempotency exists to prevent. That only mattered when the first press failed
     * in a way that made a cashier press again, which is precisely when it matters most.
     *
     * Cleared once the sale is recorded, and on a definitive refusal from the server, since
     * neither of those is the same sale being retried.
     */
    saleKey.current ??= newIdempotencyKey();
    const idempotencyKey = saleKey.current;

    let result: Awaited<ReturnType<typeof completeSale>>;
    try {
      result = await completeSale({
        branchId,
        ...toSalePayload(cart),
        payments,
        idempotencyKey,
        tier: cart.tier,
        ...(cart.customerId ? { customerId: cart.customerId } : {}),
        ...(cart.orderDiscount.kind !== DiscountKind.NONE
          ? {
              orderDiscount: { type: cart.orderDiscount.kind, value: cart.orderDiscount.value },
            }
          : {}),
      });
    } catch {
      /*
       * The request did not come back. Unlike the desktop till there is no local queue here,
       * so this genuinely cannot be resolved from the browser: the sale may have been
       * recorded before the connection dropped, or not at all.
       *
       * Saying "try again" is only honest because the key above is now stable — pressing
       * Confirm again retries THIS sale rather than starting a second one. Previously this
       * rejection was unhandled, the button stayed spinning, and the only way out was
       * reloading the page and ringing the sale afresh, which is how a customer gets charged
       * twice.
       */
      setError(
        'Carl could not be reached, so it is not known whether this sale was recorded. ' +
          'Press Confirm again — it cannot be recorded twice.',
      );
      return;
    }

    if (!result.ok) {
      // The server answered and refused. That is a different sale next time.
      saleKey.current = null;
      setError(result.message);
      setPaying(false);
      return;
    }

    saleKey.current = null;
    /*
     * The receipt is taken from the basket as it was sold, before the basket is cleared, with
     * the totals the server recorded. Lines are laid out by the same domain function the
     * desktop till uses; no figure on it is computed here that the sale did not already have.
     */
    setReceipt({
      saleNumber: result.data.saleNumber,
      total: result.data.total,
      paid: result.data.amountPaid,
      change: result.data.changeGiven,
      print: {
        ...receiptHeader,
        branchName,
        cashierName,
        saleNumber: result.data.saleNumber,
        soldAt: new Date(),
        lines: cart.lines.map((line) => {
          const figures = lineTotals(line);
          return {
            name: line.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: figures.total,
            ...(figures.discount > 0 ? { discount: figures.discount } : {}),
          };
        }),
        subtotal: totals.subtotal,
        discountTotal: totals.orderDiscount,
        taxTotal: totals.tax,
        total: result.data.total,
        payments: payments.map((payment) => ({
          method: PAYMENT_METHOD_LABEL[payment.method] ?? payment.method,
          amount: payment.amount,
          reference: payment.reference ?? null,
        })),
        amountPaid: result.data.amountPaid,
        changeGiven: result.data.changeGiven,
      },
    });
    setCart((current) => clearCart(current));
    setPaying(false);
    setBasketOpen(false);
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-3 md:flex-row md:gap-4">
      {/* Search and results */}
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            enterKeyHint="search"
            placeholder="Scan a barcode or search by name or SKU"
            aria-label="Scan or search for a product"
            autoComplete="off"
            spellCheck={false}
            className="h-14 flex-1 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 text-lg outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]"
          />
          {canSellWholesale && (
            <Button
              variant={cart.tier === 'WHOLESALE' ? 'primary' : 'secondary'}
              size="lg"
              onClick={() => {
                setCart((c) => ({ ...c, tier: c.tier === 'RETAIL' ? 'WHOLESALE' : 'RETAIL' }));
                focusSearch();
              }}
            >
              {cart.tier === 'WHOLESALE' ? 'Wholesale' : 'Retail'}
            </Button>
          )}
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-card)] border border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
          {results.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-[color:var(--color-ink-muted)]">
                {searching ? 'Searching…' : 'Scan an item, or type to search.'}
              </p>
              <p className="pointer-fine:block hidden text-xs text-[color:var(--color-ink-muted)]">
                F2 search · F4 pay · Esc cancel
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {results.map((result) => (
                <li key={result.productId}>
                  <button
                    type="button"
                    onClick={() => addProduct(result)}
                    className="flex min-h-14 w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[color:var(--color-surface-muted)] active:bg-[color:var(--color-surface-muted)]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{result.name}</span>
                      <span className="block text-xs text-[color:var(--color-ink-muted)]">
                        {result.sku} ·{' '}
                        {result.quantity > 0 ? (
                          `${formatQuantity(Math.round(result.quantity * 1000))} in stock`
                        ) : (
                          <span className="text-[color:var(--color-danger)]">Out of stock</span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatMoney(result.unitPrice)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Cart */}
      <section
        aria-label="Basket"
        className={cn(
          'min-h-0 flex-col border-[color:var(--color-border)] bg-[color:var(--color-surface)]',
          // A column beside the search from tablet width up. On a phone, a full-screen sheet
          // opened from the basket bar, so the search results keep the screen.
          'md:flex md:w-80 md:rounded-[var(--radius-card)] md:border lg:w-[26rem]',
          basketOpen
            ? 'fixed inset-0 z-40 flex pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:static md:z-auto md:p-0'
            : 'hidden',
        )}
      >
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{branchName}</p>
            <p className="truncate text-xs text-[color:var(--color-ink-muted)]">{cashierName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {cart.lines.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCart(clearCart);
                  focusSearch();
                }}
              >
                Clear
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="md:hidden"
              onClick={() => setBasketOpen(false)}
            >
              Done
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {cart.lines.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-[color:var(--color-ink-muted)]">
              The basket is empty.
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {cart.lines.map((line) => {
                const isShort = short.includes(line);
                return (
                  <li key={line.productId} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{line.name}</p>
                        <p className="text-xs tabular-nums text-[color:var(--color-ink-muted)]">
                          {formatMoney(line.unitPrice)} each
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        onClick={() => {
                          setCart((c) => removeFromCart(c, line.productId));
                          focusSearch();
                        }}
                        className="-mr-2 shrink-0 rounded-md px-2 py-1.5 text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)] active:bg-[color:var(--color-surface-muted)]"
                      >
                        Remove
                      </button>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-1">
                        {/* Large targets: these are hit with a thumb on a touch panel. */}
                        <Button
                          variant="secondary"
                          size="icon"
                          aria-label={`Reduce ${line.name}`}
                          onClick={() =>
                            setCart((c) => updateQuantity(c, line.productId, line.quantity - 1000))
                          }
                        >
                          −
                        </Button>
                        <span className="min-w-12 text-center text-sm font-semibold tabular-nums">
                          {formatQuantity(line.quantity)}
                        </span>
                        <Button
                          variant="secondary"
                          size="icon"
                          aria-label={`Add another ${line.name}`}
                          onClick={() =>
                            setCart((c) => updateQuantity(c, line.productId, line.quantity + 1000))
                          }
                        >
                          +
                        </Button>
                      </div>
                      <span className="font-semibold tabular-nums">
                        {formatMoney(line.unitPrice * (line.quantity / 1000))}
                      </span>
                    </div>

                    {isShort && (
                      <p className="mt-1.5 text-xs text-[color:var(--color-warning)]">
                        Only {formatQuantity(line.available ?? 0)} in stock at this branch.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-[color:var(--color-border)] px-4 py-3">
          {totals.orderDiscount > 0 && (
            <div className="mb-1 flex justify-between text-sm text-[color:var(--color-ink-muted)]">
              <span>Discount</span>
              <span className="tabular-nums">−{formatMoney(totals.orderDiscount)}</span>
            </div>
          )}
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[color:var(--color-ink-muted)]">Total</span>
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatMoney(totals.total)}
            </span>
          </div>

          {short.length > 0 && (
            <p className="mb-2 text-xs text-[color:var(--color-warning)]">
              Some items exceed the stock at this branch. The sale will be refused unless the count
              is corrected.
            </p>
          )}

          <Button size="pos" block disabled={cart.lines.length === 0} onClick={openPayment}>
            Pay {formatMoney(totals.total)}
          </Button>
        </footer>
      </section>

      {/* A phone's way to the basket, in thumb reach under the results. */}
      <div className="flex shrink-0 items-center gap-2 md:hidden">
        <button
          type="button"
          onClick={() => setBasketOpen(true)}
          className="flex h-14 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-4 text-left active:bg-[color:var(--color-surface-muted)]"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Basket</span>
            <span className="block truncate text-xs text-[color:var(--color-ink-muted)]">
              {cart.lines.length === 0
                ? 'Empty'
                : `${cart.lines.length} ${cart.lines.length === 1 ? 'item' : 'items'}`}
              {short.length > 0 && ' · check stock'}
            </span>
          </span>
          <span className="shrink-0 text-lg font-semibold tabular-nums">
            {formatMoney(totals.total)}
          </span>
        </button>
        <Button size="pos" disabled={cart.lines.length === 0} onClick={openPayment}>
          Pay
        </Button>
      </div>

      {paying && (
        <PaymentPanel
          total={totals.total}
          canDiscount={canDiscount}
          onCancel={() => {
            closePayment();
            focusSearch();
          }}
          onConfirm={onPay}
        />
      )}

      {receipt && (
        <ReceiptDialog
          receipt={receipt}
          printData={receipt.print}
          branchName={branchName}
          cashierName={cashierName}
          onClose={() => {
            setReceipt(null);
            focusSearch();
          }}
        />
      )}
    </div>
  );
}
