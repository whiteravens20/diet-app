// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeChoice } from '@/components/theme-choice';

/**
 * The shell of the screens of signing in and up: a way back to the home page and
 * the language and theme over the form, which stands in the middle. The bar is
 * part of the page, so on a narrow screen it pushes the form down instead of lying
 * over it.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('auth');
  return (
    <div className="flex flex-1 flex-col px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('backHome')}
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeChoice />
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center py-6">{children}</div>
    </div>
  );
}
