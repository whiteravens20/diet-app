// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Geist } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Footer } from '@/components/footer';
import { DEFAULT_PALETTE, PALETTE_COOKIE, isSupportedPalette } from '@/lib/palette';
import { Providers } from './providers';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

export const metadata: Metadata = {
  title: 'Diet App — meal planning that adds up',
  description:
    'Calorie-targeted meal plans, deterministic nutrition and consolidated shopping lists. Self-hostable, BYOK AI.',
  manifest: '/manifest.webmanifest',
  // The favicon at 16, 32 and 48 pixels in one file, and the bitmap a phone puts on its home screen.
  icons: {
    icon: [{ url: '/favicon.ico', sizes: '16x16 32x32 48x48' }],
    apple: '/apple-touch-icon.png',
  },
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
  // The nonce of this response (see `src/proxy.ts`), for the one script the page writes itself: the theme's.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang={locale} data-palette={palette} suppressHydrationWarning>
      <body className={geist.variable}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers initialPalette={palette} nonce={nonce}>
            <div className="flex min-h-screen flex-col">
              <div className="flex flex-1 flex-col">{children}</div>
              <Footer />
            </div>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
