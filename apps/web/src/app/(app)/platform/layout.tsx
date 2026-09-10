import type { Metadata, Viewport } from 'next';

/**
 * The owner console's own installable identity.
 *
 * A separate manifest from the merchant application, scoped to `/platform`, because they
 * are two different apps installed by two different people. A shopkeeper who installs Carl
 * gets a till; the platform owner gets a console for running the business behind it.
 * Sharing one manifest would put the owner's console behind the till's start URL and give
 * both the same name on a home screen.
 */
export const metadata: Metadata = {
  manifest: '/platform.webmanifest',
  applicationName: 'Carl Owner',
  appleWebApp: { capable: true, title: 'Carl Owner', statusBarStyle: 'default' },
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
