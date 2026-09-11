'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderReceipt, type ReceiptData } from '@carl/domain';

import { whatsappNumber } from '@/lib/receipt-sharing';
import { Button, buttonClasses } from '@carl/ui';

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

/** The receipt as plain text, narrow enough to read in a chat window. */
function receiptText(data: ReceiptData): string {
  return renderReceipt(data, 32).join('\n');
}

/**
 * Sending a customer their receipt.
 *
 * Most customers would rather have the receipt on their phone than on paper, and a shop with no
 * printer had nothing to give them at all. This uses the phone's own share sheet where there is
 * one, and otherwise opens WhatsApp or a text message with the receipt already written.
 *
 * Nothing is sent by Carl: the shop's own WhatsApp or messaging app sends it, so there is no
 * gateway to pay for, no customer number stored for the purpose, and no message that can go out
 * without the cashier seeing it.
 */
export function ShareReceiptButton({
  receipt,
  customerPhone,
  size = 'sm',
}: {
  receipt: ReceiptSource;
  customerPhone?: string | null;
  size?: 'sm' | 'lg';
}) {
  const [choosing, setChoosing] = useState(false);
  const data: ReceiptData = { ...receipt, soldAt: new Date(receipt.soldAt) };
  const text = receiptText(data);
  const number = whatsappNumber(customerPhone);

  async function share() {
    // The share sheet is the best answer where it exists: the customer may not use WhatsApp.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `Receipt ${data.saleNumber}`, text });
        return;
      } catch {
        // Dismissed, or refused by the browser. Fall through to the explicit choices.
      }
    }
    setChoosing(true);
  }

  const encoded = encodeURIComponent(text);
  return (
    <>
      <Button variant="secondary" size={size} onClick={() => void share()}>
        Send receipt
      </Button>
      {choosing && (
        <div className="mt-2 flex flex-wrap gap-2">
          <a
            href={`https://wa.me/${number ?? ''}?text=${encoded}`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
          >
            WhatsApp
          </a>
          {/* `?body=` is understood by Android and by iOS 8 and later. */}
          <a
            href={`sms:${number ?? ''}?body=${encoded}`}
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
          >
            Text message
          </a>
          <button
            type="button"
            onClick={() => setChoosing(false)}
            className={buttonClasses({ variant: 'ghost', size: 'sm' })}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

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
