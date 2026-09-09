'use client';

import { Alert } from '@carl/ui';

/**
 * A prompt that expenses are waiting.
 *
 * Kept visible rather than tucked behind a filter: an approval queue nobody sees is an
 * approval step that quietly stops happening, and the separation between recording and
 * approving is the only control on expense fraud.
 */
export function ExpenseApproval({ count }: { count: number }) {
  return (
    <Alert tone="warning" title={`${count} expense${count === 1 ? '' : 's'} awaiting approval`}>
      An expense recorded by someone who cannot approve it waits here. It does not affect the cash
      reconciliation until it is approved.
    </Alert>
  );
}
