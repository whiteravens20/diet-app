// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * next-intl request config — loaded by the NextIntl plugin (see next.config.ts)
 * for every server render. Picks the locale from the NEXT_LOCALE cookie and
 * lazy-loads the matching messages bundle, a language of `LOCALES` only, with
 * the English messages under it. The cookie is the only server-side signal (no
 * Accept-Language parsing); a fresh visitor gets DEFAULT_LOCALE until the
 * client-side LocaleProvider writes the cookie based on navigator.language.
 */
import type { Locale } from '@diet-app/shared';
import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import english from '../../messages/en.json';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isSupportedLocale } from '../lib/locale';
import { type Messages, withEnglishUnder } from './fallback';

/**
 * The messages of each language of `LOCALES`, named one by one: a file of the
 * folder that is not on the list (a translation still being written) is never
 * built into the application, let alone shown.
 */
const CATALOGUES: Record<Locale, () => Promise<{ default: Messages }>> = {
  en: () => import('../../messages/en.json'),
  pl: () => import('../../messages/pl.json'),
};

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(raw) ? raw : DEFAULT_LOCALE;
  const own = (await CATALOGUES[locale]()).default;
  return { locale, messages: locale === 'en' ? own : withEnglishUnder(english, own) };
});
