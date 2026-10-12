// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Locale } from '@diet-app/shared';
import { LOCALES } from '@diet-app/shared/options';

/**
 * Locale resolution rules for the web app (kept deliberately simple — no
 * Accept-Language header parsing, no URL prefix):
 *
 *  1. Authenticated visitors → `user.locale` from `GET /users/me`.
 *  2. Anyone with a `NEXT_LOCALE` cookie set previously → use that.
 *  3. On first visit (no cookie), the client-side `LocaleProvider` reads
 *     `navigator.language` and writes the matching supported locale into the
 *     cookie. This causes a one-time "flash of English" before the cookie
 *     takes effect, but avoids the complexity of server-side header parsing.
 *  4. Fallback → `DEFAULT_LOCALE`.
 *
 * The single source of truth for "which locales exist" is the contract
 * (`@diet-app/shared`). The list is taken from its `options` file alone: every
 * page runs this, and none of them should load the contract's schemas for it.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const DEFAULT_LOCALE: Locale = 'en';
export const SUPPORTED_LOCALES = LOCALES;

/** Type-guard that narrows a runtime string to a supported `Locale`. */
export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Best-supported match for `navigator.language` (e.g. `pl-PL` → `pl`).
 * Returns null when the browser language isn't one we ship.
 */
export function pickFromBrowserLanguage(language: string | undefined | null): Locale | null {
  if (!language) return null;
  const primary = language.toLowerCase().split('-')[0];
  return isSupportedLocale(primary) ? primary : null;
}
