'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderReceipt, type ReceiptData } from '@carl/domain';
import { Button } from '@carl/ui';

/** How a payment method reads on a customer's receipt. */
export const PAYMENT_METHOD_LABEL: Readonly<Record<string, string>> = {
  CASH: 'Cash',
  MOMO: 'Mobile money',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  CREDIT: 'On account',
  OTHER: 'Other',
};

/**
 * The customer's receipt, for the browser's print dialog.
 *
 * Laid out by `renderReceipt`, the function the desktop till prints with, so the web till
 * and the desktop till cannot disagree about what a receipt says.
 *
 * Printing used to print the page: the till's search results and basket behind a dialog
 * holding four figures, with no business name, no items, no payment method. This renders the
 * real receipt straight into <body>, where the print stylesheet prints it and nothing else,
 * at the width of an 80mm roll. On screen it is not shown.
 */
export function PrintableReceipt({ data }: { data: ReceiptData }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.body);
  }, []);

  if (!host) return null;
  return createPortal(
    <div data-receipt-print className="hidden print:block">
      <pre>{renderReceipt(data, 42).join('\n')}</pre>
    </div>,
    host,
  );
}

/** Serialisable from a server component: the sale time travels as an ISO string. */
export type ReceiptSource = Omit<ReceiptData, 'soldAt'> & { soldAt: string };

/** "Print receipt" for a sale that has already happened. */
export function PrintReceiptButton({ receipt }: { receipt: ReceiptSource }) {
  return (
    <>
      <PrintableReceipt data={{ ...receipt, soldAt: new Date(receipt.soldAt) }} />
      <Button variant="secondary" size="sm" onClick={() => window.print()}>
        Print receipt
      </Button>
    </>
  );
}
