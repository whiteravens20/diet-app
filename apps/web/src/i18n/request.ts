/**
 * next-intl request config — loaded by the NextIntl plugin (see next.config.ts)
 * for every server render. Picks the locale from the NEXT_LOCALE cookie and
 * lazy-loads the matching messages bundle. The cookie is the only server-side
 * signal (no Accept-Language parsing); a fresh visitor gets DEFAULT_LOCALE
 * until the client-side LocaleProvider writes the cookie based on
 * navigator.language.
 */
import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale } from '../lib/locale';

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(raw) ? raw : DEFAULT_LOCALE;
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return { locale, messages };
});
