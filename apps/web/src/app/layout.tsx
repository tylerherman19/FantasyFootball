import type { Metadata, Viewport } from 'next';
import { themeScript } from '@/lib/theme-script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fantasy Football Edge',
  description: 'Every fantasy decision priced in championship probability.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Declared so the browser paints its own chrome to match the chosen theme
  // rather than flashing white behind a dark page.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f4' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1114' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Ahead of the bundle on purpose: see lib/theme-script. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
