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
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Carl',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A POS is operated by touch on a fixed panel; pinch-zoom during checkout is a misfire,
  // but zoom is left enabled because disabling it entirely fails WCAG 1.4.4.
  maximumScale: 5,
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
