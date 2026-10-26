// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** How the application looks and reads for an account: its language, its theme and palette, and the unit it weighs in. */
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { type Palette, type WeightUnit, type SessionUser, type Theme } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SUPPORTED_PALETTES } from '@/lib/palette';
import { usePalette } from '@/app/providers';

export function LanguageCard() {
  const t = useTranslations('settings');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('language')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <LanguageSwitcher />
        <p className="text-xs text-muted-foreground">{t('languageSyncHint')}</p>
      </CardContent>
    </Card>
  );
}

/** The theme the pages have now, which is the account's once its pages took it on (`AccountPreferences`). */
export function ThemeCard() {
  const t = useTranslations('settings');
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount flag; gates next-themes hydration so first client paint matches SSR
  useEffect(() => setMounted(true), []);

  async function pick(next: Theme) {
    setTheme(next);
    queryClient.setQueryData<SessionUser>(['session'], (me) => me && { ...me, theme: next });
    try {
      await api.patch('/users/me', { theme: next });
    } catch {
      // The page has changed already. Where the server did not take it, the next page brings the account's saved one back.
    }
  }

  if (!mounted)
    return (
      <Card>
        <CardContent className="h-16" />
      </Card>
    );

  const options: { value: Theme; label: string }[] = [
    { value: 'light', label: t('themeLight') },
    { value: 'dark', label: t('themeDark') },
    { value: 'system', label: t('themeSystem') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('theme')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          {options.map((o) => (
            <Button
              key={o.value}
              type="button"
              size="sm"
              variant={theme === o.value ? 'primary' : 'outline'}
              aria-pressed={theme === o.value}
              onClick={() => void pick(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('themeSyncHint')}</p>
      </CardContent>
    </Card>
  );
}

// Swatch colours rendered next to each palette name in the picker. Tied to
// the primary token of each palette so the chip preview matches the actual
// scheme without needing to render a hidden DOM. Order matches `Palette` enum.
const PALETTE_SWATCHES: Record<Palette, string> = {
  default: 'oklch(0.62 0.15 155)',
  ocean: 'oklch(0.6 0.15 240)',
  forest: 'oklch(0.52 0.13 145)',
  sunset: 'oklch(0.65 0.16 50)',
  mono: 'oklch(0.3 0 0)',
  rose: 'oklch(0.6 0.17 5)',
};

/**
 * The unit body weights are shown and typed in. Until the account chooses,
 * the application goes by where the reader's browser says they are; the
 * choice is kept with the account, and every page that shows a weight
 * follows it. The API keeps kilograms whatever is chosen.
 */
export function WeightUnitCard({ me, onSaved }: { me: SessionUser; onSaved: () => void }) {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  // What was chosen and is on its way: shown in the same breath as the click.
  const [chosen, setChosen] = useState<WeightUnit | null | undefined>(undefined);
  const value = chosen === undefined ? me.weightUnit : chosen;

  async function pick(next: WeightUnit | null) {
    setError(null);
    setChosen(next);
    try {
      await api.patch('/users/me', { weightUnit: next });
      onSaved();
    } catch (e) {
      setChosen(undefined);
      setError(errorText(e, t('weightUnitFailed')));
    }
  }

  const options: { value: WeightUnit | null; label: string }[] = [
    { value: null, label: t('weightUnitByRegion') },
    { value: 'kg', label: t('weightUnitKg') },
    { value: 'lb', label: t('weightUnitLb') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('weightUnit')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('weightUnit')}>
          {options.map((o) => (
            <Button
              key={o.value ?? 'region'}
              type="button"
              size="sm"
              variant={value === o.value ? 'primary' : 'outline'}
              aria-pressed={value === o.value}
              onClick={() => void pick(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('weightUnitHint')}</p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The palette the pages have now, which is the account's once its pages took it on (`AccountPreferences`). */
export function PaletteCard() {
  const t = useTranslations('settings');
  const tPalette = useTranslations('settings.paletteOption');
  const { palette: value, setPalette } = usePalette();
  const queryClient = useQueryClient();

  async function pick(next: Palette) {
    setPalette(next); // applies <html data-palette> + cookie immediately
    queryClient.setQueryData<SessionUser>(['session'], (me) => me && { ...me, palette: next });
    try {
      await api.patch('/users/me', { palette: next });
    } catch {
      // The page has changed already. Where the server did not take it, the next page brings the account's saved one back.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('palette')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_PALETTES.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={value === p ? 'primary' : 'outline'}
              aria-pressed={value === p}
              onClick={() => void pick(p)}
              className="gap-2"
            >
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-full border border-border"
                style={{ backgroundColor: PALETTE_SWATCHES[p] }}
              />
              {tPalette(p)}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('paletteSyncHint')}</p>
      </CardContent>
    </Card>
  );
}
