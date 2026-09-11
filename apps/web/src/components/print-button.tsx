'use client';

import { Button } from '@carl/ui';

/** Opens the browser's print dialog. A server component cannot, and this is all it takes. */
export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
