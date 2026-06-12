import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Standalone shell for the Phase H reviewer interface — public route, no app
 * sidebar, no user identity. Admin's `(app)` layout group requires the user
 * JWT which an invited reviewer does not have.
 */
export default function ReviewLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('review');
  return (
    <div className="mx-auto flex-1 max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{t('subhead')}</p>
      </header>
      {children}
    </div>
  );
}
