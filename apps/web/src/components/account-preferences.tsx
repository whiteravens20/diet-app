// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import type { SessionUser } from '@diet-app/shared';
import { usePalette } from '@/app/providers';
import { api } from '@/lib/api';
import { LOCALE_COOKIE } from '@/lib/locale';

/**
 * Puts the account's language, theme and palette on this browser once the account
 * is known. The API keeps them, so they follow the account to every browser it signs
 * in on, a new one included, where nothing was chosen yet. It is done once a page:
 * what the reader picks afterwards stays until the next page, which brings the
 * account's choice again, the same one once it was saved.
 *
 * An account made before its language was kept holds English whatever its owner
 * reads (`localeChosen` is false): it keeps the language of this page instead,
 * which is saved as the account's and goes with it from then on.
 */
export function AccountPreferences() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const locale = useLocale();
  const { theme, setTheme } = useTheme();
  const { palette, setPalette } = usePalette();
  const done = useRef(false);

  useEffect(() => {
    if (!me || done.current) return;
    done.current = true;
    if (me.palette !== palette) setPalette(me.palette);
    if (me.theme !== theme) setTheme(me.theme);
    if (!me.localeChosen) {
      // Tried again on the next page when it does not get through.
      void api
        .patch<SessionUser>('/users/me', { locale })
        .then((saved) => queryClient.setQueryData(['session'], saved))
        .catch(() => undefined);
    } else if (me.locale !== locale) {
      document.cookie = `${LOCALE_COOKIE}=${me.locale}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      // The server renders the page in the language of the cookie, so the page is
      // loaded again in the account's. Not where the browser keeps no cookie: the
      // page would come back in the same language and load again for ever.
      if (document.cookie.includes(`${LOCALE_COOKIE}=${me.locale}`)) window.location.reload();
    }
  }, [me, locale, theme, setTheme, palette, setPalette, queryClient]);

  return null;
}
