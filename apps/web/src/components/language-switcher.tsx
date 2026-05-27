'use client';

import { Globe } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Locale } from '@diet-app/shared';
import { LOCALE_COOKIE, SUPPORTED_LOCALES, isSupportedLocale } from '@/lib/locale';
import { api, ApiClientError, tokenStore } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Single language-selector component, shared between public surfaces (landing,
 * auth pages) and authenticated surfaces (Settings). For signed-in users it
 * additionally persists the choice via PATCH /users/me so the locale follows
 * them to every device.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const router = useRouter();
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
      setPending(false);
      router.refresh();
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
          'h-9 rounded-md border border-border bg-transparent px-2 pr-8 text-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:opacity-50',
        )}
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

/**
 * Cheap "do we have an access token?" check. Avoids a network probe; the
 * Settings page already gates on real auth via a server-side mechanism.
 * Reactive via a `storage` event listener so logout in another tab flips
 * the switcher back to anonymous behaviour.
 */
function useIsAuthenticated(): boolean {
  const [authed, setAuthed] = useState(false);
  const mounted = useRef(false);
  // Mount gate: tokenStore only works on the client, so the first client
  // render has to match the SSR'd output (assumed-anonymous) before this
  // resolves the real value. Same shape as ThemeToggle's hydration gate.
  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAuthed(Boolean(tokenStore.access));
    const onStorage = () => mounted.current && setAuthed(Boolean(tokenStore.access));
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return authed;
}
