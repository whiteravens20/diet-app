// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeChoice } from '@/components/theme-choice';

/** Centred shell for the auth screens. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex flex-1 items-center justify-center px-6 py-12">
      <header className="absolute right-6 top-6 flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeChoice />
      </header>
      {children}
    </div>
  );
}
