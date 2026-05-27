'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useEffect, useState, type ReactNode } from 'react';
import { LOCALE_COOKIE, pickFromBrowserLanguage } from '../lib/locale';

/** App-wide client providers: data fetching cache + dark-mode theme. */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={client}>
        <FirstVisitLocaleDetector />
        {children}
      </QueryClientProvider>
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
