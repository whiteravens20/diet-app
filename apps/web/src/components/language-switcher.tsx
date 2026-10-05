// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Globe } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ChangeEvent } from 'react';
import { Locale } from '@diet-app/shared';
import { LOCALE_COOKIE, SUPPORTED_LOCALES, isSupportedLocale } from '@/lib/locale';
import { api, ApiClientError } from '@/lib/api';
import { useIsAuthenticated } from '@/lib/use-is-authenticated';
import { cn } from '@/lib/utils';

/**
 * Single language-selector component, shared between public surfaces (landing,
 * auth pages) and authenticated surfaces (Settings). For signed-in users it
 * additionally persists the choice via PATCH /users/me so the locale follows
 * them to every device.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const currentLocale = useLocale();
  const t = useTranslations('languageSwitcher');
  const tLocales = useTranslations('locales');
  const [pending, setPending] = useState(false);
  const isAuthed = useIsAuthenticated();
  const initial = isSupportedLocale(currentLocale) ? currentLocale : 'en';
  const [value, setValue] = useState<Locale>(initial);

  async function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!isSupportedLocale(next) || next === value) return;
    setValue(next);
    setPending(true);
    // Cookie first — guarantees the choice survives even if the API call fails.
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    try {
      if (isAuthed) await api.patch('/users/me', { locale: next });
    } catch (err) {
      // Best-effort sync; the cookie already won. Surface only real errors.
      if (!(err instanceof ApiClientError) || err.status !== 401) console.error(err);
    } finally {
      // Hard reload rather than router.refresh(): next-intl's client provider
      // caches the messages bundle in React context, so an RSC re-fetch alone
      // doesn't reliably swap every consumer's translations. A full reload
      // re-runs the server-side locale resolution and hydrates the provider
      // fresh with the new bundle.
      window.location.reload();
    }
  }

  return (
    <label className={cn('inline-flex items-center gap-2 text-sm', className)}>
      <Globe size={16} aria-hidden className="text-muted-foreground" />
      <span className="sr-only">{t('label')}</span>
      <select
        aria-label={t('ariaLabel')}
        value={value}
        onChange={onChange}
        disabled={pending}
        className={cn(
          // `appearance-none` strips the native chrome that ignores our colour
          // tokens (the white pill some browsers ship by default). The chevron
          // is re-drawn via inline background-image below so the control stays
          // recognisable as a select.
          'h-9 appearance-none rounded-md border border-border bg-background text-foreground',
          'px-2 pr-8 text-sm',
          // Options popup: most browsers respect bg/text on <option> only when
          // they're explicit. Without these the dropdown reverts to OS colours
          // and looks "white" in any dark or tinted palette.
          '[&>option]:bg-background [&>option]:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:opacity-50',
        )}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='currentColor'><path d='M4 6l4 4 4-4'/></svg>\")",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.5rem center',
          backgroundSize: '12px',
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {tLocales(locale)}
          </option>
        ))}
      </select>
    </label>
  );
}
