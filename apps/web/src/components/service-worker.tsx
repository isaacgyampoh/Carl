'use client';

import { useEffect, useState } from 'react';

/**
 * Registers the service worker and shows a plain offline banner.
 *
 * The banner exists because the most damaging thing a POS can do is look normal while it
 * cannot reach the server. A cashier who knows they are offline behaves differently — and
 * correctly.
 */
export function ServiceWorker() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      // Registration failing is not worth interrupting anyone over: the application works
      // without it, just without offline awareness.
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[60] bg-[color:var(--color-warning)] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-center text-sm font-medium text-[color:var(--color-ink)]"
    >
      No connection. Carl cannot record a sale until this is restored.
    </div>
  );
}
