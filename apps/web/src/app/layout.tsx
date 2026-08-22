import type { Metadata, Viewport } from 'next';
import { Archivo, Roboto_Mono } from 'next/font/google';
import { themeScript } from '@/lib/theme-script';
import './globals.css';

/*
 * Type does most of the work in this genre.
 *
 * The reference is FiveThirtyEight at its best: a heavy grotesk headline that
 * states the finding, a quiet deck underneath, and numbers in something
 * monospaced so a column of them lines up and can be scanned rather than read.
 * On the system stack all three of those jobs were done by one font at three
 * sizes, which is why the pages read as a list of paragraphs rather than as an
 * argument.
 *
 * Archivo is the closest open face to the Atlas Grotesk 538 used — same square
 * grotesk skeleton, holds up at heavy weights, stays legible small. Roboto Mono
 * stands in for Decima Mono on figures.
 *
 * Self-hosted at build time by next/font, so no third-party request at runtime
 * and no layout shift while a webfont loads.
 */
const display = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const mono = Roboto_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

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
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${mono.variable}`}>
      <head>
        {/* Ahead of the bundle on purpose: see lib/theme-script. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
