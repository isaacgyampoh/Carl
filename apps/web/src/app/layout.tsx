import type { Metadata, Viewport } from 'next';
import { ServiceWorker } from '@/components/service-worker';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Carl',
    template: '%s · Carl',
  },
  description: 'Carl — point of sale, inventory and business management for multi-branch retail.',
  applicationName: 'Carl',
  formatDetection: { telephone: false },
  /*
   * No manifest here, deliberately.
   *
   * Declared on the root layout, every page inherited an installable manifest with
   * `start_url: "/"` — the owner's entry, and before that the marketing page. Installing from
   * any screen, a till included, produced an application that opened on the main website.
   * Only the till's screens declare a manifest now, and it is the POS app's.
   */
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    // The only icon iOS uses for the home screen. It reads neither the manifest nor SVG, so
    // without this an installed Carl on an iPhone showed a screenshot of the page.
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A POS is operated by touch on a fixed panel; pinch-zoom during checkout is a misfire,
  // but zoom is left enabled because disabling it entirely fails WCAG 1.4.4.
  maximumScale: 5,
  // An installed app draws edge to edge, under the notch and the home indicator. The shell
  // pads itself by the safe-area insets so nothing it shows lands beneath them.
  viewportFit: 'cover',
  // On Android the keyboard shrinks the layout instead of covering it, so a field near the
  // bottom of the screen stays above the keyboard rather than behind it.
  interactiveWidget: 'resizes-content',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorker />
        {children}
      </body>
    </html>
  );
}
