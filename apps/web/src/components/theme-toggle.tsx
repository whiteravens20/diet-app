// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Light/dark toggle. Renders only after mount to avoid a hydration mismatch. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
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
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}
