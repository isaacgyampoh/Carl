import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last thing between a broken render and an empty window.
 *
 * React unmounts the whole tree when a render throws and nothing catches it. On a till that
 * is a blank screen: no message, no button, nothing for a cashier with a customer waiting to
 * do except call somebody. Measured on this application before this existed — a deliberate
 * throw in `App` left `document.body.innerText` empty and `#root` with no children at all.
 *
 * So the till always shows words. This also clears the boot mark from index.html, and does it
 * on mount rather than in `main.tsx` immediately after `render()` — because `render()`
 * returning is not the same as anything having been drawn, and removing the mark before the
 * first commit is precisely what turned a failed render into a blank window.
 */
interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

export class BootBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidMount(): void {
    document.getElementById('boot')?.remove();
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept to the console rather than sent anywhere: a till's crash detail can name a
    // cashier or a customer, and this machine is in a shop rather than in a data centre.
    console.error('Carl stopped while drawing the screen.', error, info.componentStack);
    document.getElementById('boot')?.remove();
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main
        style={{
          height: '100vh',
          display: 'grid',
          placeContent: 'center',
          justifyItems: 'center',
          textAlign: 'center',
          gap: 16,
          padding: 32,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>Carl stopped while drawing the screen.</h1>
        <p style={{ color: '#9aa4b2', maxWidth: 520, margin: 0 }}>
          The till has not lost anything: a sale is written down before its receipt is printed, and
          nothing was in progress on this screen. Starting again is safe.
        </p>
        <p
          style={{
            color: '#9aa4b2',
            maxWidth: 520,
            margin: 0,
            fontSize: 14,
            wordBreak: 'break-word',
          }}
        >
          {error.message}
        </p>
        <button
          className="primary"
          type="button"
          onClick={() => window.location.reload()}
          style={{ justifySelf: 'center' }}
        >
          Start again
        </button>
      </main>
    );
  }
}
