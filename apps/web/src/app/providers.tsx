// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Palette } from '@diet-app/shared';
import { ServiceWorker } from '../components/service-worker';
import { DEFAULT_PALETTE, PALETTE_COOKIE } from '../lib/palette';
import { LOCALE_COOKIE, pickFromBrowserLanguage } from '../lib/locale';

interface PaletteContextValue {
  palette: Palette;
  setPalette: (next: Palette) => void;
}

const PaletteContext = createContext<PaletteContextValue>({
  palette: DEFAULT_PALETTE,
  setPalette: () => undefined,
});

export function usePalette(): PaletteContextValue {
  return useContext(PaletteContext);
}

/**
 * App-wide client providers: data fetching cache, dark-mode theme, palette.
 * `nonce` is the one the response's content security policy names: the theme
 * provider writes a script into the page (it sets the theme before the first
 * paint), and that script has to carry it to run.
 */
export function Providers({
  children,
  initialPalette,
  nonce,
}: {
  children: ReactNode;
  initialPalette: Palette;
  nonce?: string;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        // A request is sent whatever the browser says of its network: it is the request that finds
        // out, and a read that gets no answer is answered from what the browser kept (`lib/offline.ts`).
        // Held back until the network returns, a read would show a page that waits for ever, and a
        // change would be sent later without anybody having asked for it then.
        defaultOptions: { queries: { staleTime: 30_000, retry: 1, networkMode: 'always' }, mutations: { networkMode: 'always' } },
      }),
  );

  const [palette, setPaletteState] = useState<Palette>(initialPalette);

  // Mirror palette changes onto `<html data-palette>` + the cookie so SSR and
  // CSR agree. `PATCH /users/me` (cross-device sync) is owned by the settings
  // UI, not here — keeps this provider session-agnostic.
  const setPalette = useCallback((next: Palette) => {
    setPaletteState(next);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.palette = next;
      document.cookie = `${PALETTE_COOKIE}=${next}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    }
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={nonce}>
      <PaletteContext.Provider value={{ palette, setPalette }}>
        <QueryClientProvider client={client}>
          <FirstVisitLocaleDetector />
          <ServiceWorker />
          {children}
        </QueryClientProvider>
      </PaletteContext.Provider>
    </ThemeProvider>
  );
}

/**
 * On the first visit (no NEXT_LOCALE cookie yet) read navigator.language,
 * pick the matching supported locale, write the cookie and reload so the
 * server picks up the new locale on the next render. After the cookie is set
 * this component is a no-op. Hard reload (rather than router.refresh) because
 * next-intl's client provider context doesn't pick up new messages from an
 * RSC re-fetch alone — same reason the language switcher reloads.
 */
function FirstVisitLocaleDetector() {
  useEffect(() => {
    const hasCookie = document.cookie
      .split(';')
      .some((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
    if (hasCookie) return;
    const detected = pickFromBrowserLanguage(navigator.language);
    if (!detected) return;
    document.cookie = `${LOCALE_COOKIE}=${detected}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    window.location.reload();
  }, []);
  return null;
}
