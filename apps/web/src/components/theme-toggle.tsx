// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { SessionUser, Theme } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/**
 * Light/dark toggle of the account's pages. The choice is the account's, as the one
 * made in the settings is, so it is saved for the other browsers it signs in on.
 * Renders only after mount to avoid a hydration mismatch.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const t = useTranslations('themeToggle');
  const [mounted, setMounted] = useState(false);
  // Mount gate: next-themes resolves the theme only on the client, so the first
  // client render must match the server output (no icon) to avoid a mismatch.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount flag; the effect runs once to gate hydration, not on every render
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="size-10" />;

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t('ariaLabel')}
      onClick={() => {
        const next: Theme = resolvedTheme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        queryClient.setQueryData<SessionUser>(['session'], (me) => me && { ...me, theme: next });
        // The page has changed already. Where the server did not take it, the next page brings the account's saved one back.
        api.patch('/users/me', { theme: next }).catch(() => undefined);
      }}
    >
      {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}
