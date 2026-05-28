import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Geist } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { DEFAULT_PALETTE, PALETTE_COOKIE, isSupportedPalette } from '@/lib/palette';
import { Providers } from './providers';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

export const metadata: Metadata = {
  title: 'Diet App — meal planning that adds up',
  description:
    'Calorie-targeted meal plans, deterministic nutrition and consolidated shopping lists. Self-hostable, BYOK AI.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1a201c' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // Bake the palette onto <html> server-side so first paint never flashes the
  // wrong colours. Client-side PaletteProvider keeps this attribute in sync as
  // the user picks new palettes from settings.
  const cookieStore = await cookies();
  const rawPalette = cookieStore.get(PALETTE_COOKIE)?.value;
  const palette = isSupportedPalette(rawPalette) ? rawPalette : DEFAULT_PALETTE;
  return (
    <html lang={locale} data-palette={palette} suppressHydrationWarning>
      <body className={geist.variable}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers initialPalette={palette}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
