// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const CHOICES = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

/**
 * Light, dark or the device's own, for the pages anybody can open. The choice
 * stays in this browser; an account keeps its own in the settings.
 */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations('themeToggle');
  const [mounted, setMounted] = useState(false);
  // The choice is in the browser's storage, which the server has not got: the
  // first client render matches the server's, an empty place of the same size.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount flag; the effect runs once to gate hydration, not on every render
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-9 w-[100px]" />;

  return (
    <div
      role="group"
      aria-label={t('choice')}
      className="inline-flex h-9 items-center gap-0.5 rounded-md border border-input p-0.5"
    >
      {CHOICES.map((choice) => {
        const chosen = (theme ?? 'system') === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            aria-label={t(choice.value)}
            aria-pressed={chosen}
            onClick={() => setTheme(choice.value)}
            className={cn(
              'inline-flex size-[30px] items-center justify-center rounded-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              chosen
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <choice.icon size={16} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
