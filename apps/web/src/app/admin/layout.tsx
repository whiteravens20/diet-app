import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

/** Plain shell for the F16 admin panel — no app sidebar, no user identity. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('admin');
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
