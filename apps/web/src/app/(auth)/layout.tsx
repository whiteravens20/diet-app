import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';

/** Centred shell for the auth screens. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <header className="absolute right-6 top-6">
        <LanguageSwitcher />
      </header>
      {children}
    </div>
  );
}
