import type { Metadata, Viewport } from 'next';

/**
 * The owner console's metadata.
 *
 * No manifest, deliberately. The console was its own installable app ("Carl Owner", scoped to
 * /platform), which put a second Carl on the owner's home screen beside the till app and made
 * it easy to open one while meaning the other. The console is used in the browser at the main
 * address; the installed Carl app is the POS.
 */
export const metadata: Metadata = {
  // Not something to index: it is a private operations console, not a page for anyone else.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#111827',
  // The owner works one-handed on a phone; a layout that can be zoomed away from is worse
  // than one that fits, but pinch-zoom stays available because refusing it breaks
  // accessibility for anyone who needs to magnify a figure.
  width: 'device-width',
  initialScale: 1,
};

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return children;
}
