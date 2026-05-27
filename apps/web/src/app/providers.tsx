'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useRouter } from 'next/navigation';
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
 * pick the matching supported locale, write the cookie and trigger a server
 * refresh so the page re-renders in that locale. After the cookie is set
 * this component is a no-op. The signed-in case is handled separately by
 * the Settings page calling PATCH /users/me + setting the same cookie.
 */
function FirstVisitLocaleDetector() {
  const router = useRouter();
  useEffect(() => {
    const hasCookie = document.cookie
      .split(';')
      .some((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
    if (hasCookie) return;
    const detected = pickFromBrowserLanguage(navigator.language);
    if (!detected) return;
    document.cookie = `${LOCALE_COOKIE}=${detected}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    router.refresh();
  }, [router]);
  return null;
}
