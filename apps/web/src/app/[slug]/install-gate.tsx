'use client';

import { useEffect, useState } from 'react';
import { Button } from '@carl/ui';

/**
 * Installation before the PIN pad.
 *
 * Carl is used on a counter, all day, often on a machine that also has a browser open for
 * something else. A tab gets closed, loses its window, and competes with whatever else is
 * running; an installed application has its own window, its own icon and its own service
 * worker cache, which is what makes it work when the connection does not.
 *
 * ## Why there is still a way past it
 *
 * A page cannot make a browser install anything. `beforeinstallprompt` fires only on
 * Chromium, only over HTTPS, only once the service worker and manifest are accepted, and
 * never on iOS Safari — where installing is a manual Share-menu step nobody can trigger from
 * script. A gate that could not be passed would lock out every shop on an unsupported
 * browser, so this one is firm and passable: installation is the obvious action, continuing
 * in the browser is available and unadvertised.
 *
 * Once the application IS installed it stops appearing at all, because a prompt to install
 * something already installed is how people learn to dismiss prompts without reading them.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // `display-mode: standalone` covers Chromium and Android; `navigator.standalone` is the
  // iOS equivalent and exists nowhere else.
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function InstallGate({ children }: { children: React.ReactNode }) {
  // `null` until the browser has been asked: rendering the gate first and then hiding it
  // makes an installed application flash a screen telling its user to install it.
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [proceeding, setProceeding] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());

    const onPrompt = (event: Event) => {
      // Held rather than fired: the browser offers this once, and spending it the moment the
      // page loads shows a dialog to someone who has not read anything yet.
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    // Covers the app being launched standalone after this component mounted.
    const media = window.matchMedia('(display-mode: standalone)');
    const onChange = () => setInstalled(isStandalone());
    media.addEventListener('change', onChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      media.removeEventListener('change', onChange);
    };
  }, []);

  if (installed === null) return null;
  if (installed || proceeding) return <>{children}</>;

  async function install() {
    if (!prompt) return;
    setBusy(true);
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // Spent either way: the browser will not replay it.
      setPrompt(null);
      if (outcome === 'accepted') setInstalled(true);
    } catch {
      // A refused or unavailable prompt is not an error worth showing. The manual
      // instructions below are the answer in both cases.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold tracking-tight">Install Carl</h1>
      <p className="mt-2 text-sm text-[color:var(--color-text-muted)]">
        Carl runs as an application on this computer, phone or POS terminal. Installed, it opens in
        its own window and keeps selling when the internet drops.
      </p>

      {prompt ? (
        <Button className="mt-6 w-full" onClick={() => void install()} loading={busy}>
          Install application
        </Button>
      ) : (
        <div className="mt-6 rounded-lg border border-[color:var(--color-border)] p-4 text-sm">
          <p className="font-medium">Install from your browser menu</p>
          <ul className="mt-2 space-y-1 text-[color:var(--color-text-muted)]">
            <li>
              <span className="font-medium text-[color:var(--color-text)]">Windows</span> — Edge or
              Chrome: the install icon at the right of the address bar, or menu → Apps → Install.
            </li>
            <li>
              <span className="font-medium text-[color:var(--color-text)]">Android</span> — menu →
              Add to home screen.
            </li>
            <li>
              <span className="font-medium text-[color:var(--color-text)]">iPhone or iPad</span> —
              Share → Add to Home Screen.
            </li>
          </ul>
        </div>
      )}

      {/* Deliberately quiet. Installing is the right answer; this exists so a browser that
          cannot install never becomes a shop that cannot sell. */}
      <button
        type="button"
        onClick={() => setProceeding(true)}
        className="mt-6 w-full text-sm text-[color:var(--color-text-muted)] underline-offset-4 hover:underline"
      >
        Continue in this browser
      </button>
    </div>
  );
}
