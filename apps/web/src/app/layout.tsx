import type { Metadata } from 'next';
import { Archivo, Libre_Franklin } from 'next/font/google';
import './globals.css';

/*
 * Franklin for reading, Archivo for headlines and figures.
 *
 * Both are grotesks in the American newspaper lineage, which is the register
 * this product is written in — a chart desk, not a SaaS dashboard. Archivo's
 * tighter, heavier caps make a chart title read as a headline; Franklin sets
 * long explanatory text without fatigue.
 */
const display = Archivo({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const body = Libre_Franklin({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Fantasy Football Edge',
  description: 'Every fantasy decision priced in championship probability.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
