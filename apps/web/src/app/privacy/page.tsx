// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Metadata } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeChoice } from '@/components/theme-choice';
import { InstanceFacts } from './instance-facts';

export const metadata: Metadata = {
  title: 'Privacy — Diet App',
};

const SECTIONS = {
  account: ['address', 'secrets', 'panel', 'export', 'deletion'],
  kept: ['notifications', 'ai', 'limits', 'recipe'],
  browser: ['sources', 'session', 'storage'],
  phone: ['permissions', 'none', 'session', 'updates', 'unlock'],
} as const;

/**
 * What the application keeps, sends out and leaves in the browser and on the phone, as its code does it; what the
 * instance's operator decides (backups, the server's logs) is in their terms. The instance's own choices come from
 * its public configuration.
 */
export default function PrivacyPage() {
  const t = useTranslations('privacy');

  const section = (key: keyof typeof SECTIONS) => (
    <section aria-labelledby={`privacy-${key}`} className="space-y-3">
      <h2 id={`privacy-${key}`} className="text-xl font-semibold tracking-tight text-foreground">
        {t(`${key}.title`)}
      </h2>
      <ul className="list-disc space-y-1.5 pl-6">
        {SECTIONS[key].map((line) => (
          <li key={line}>{t(`${key}.${line}`)}</li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
          {t('back')}
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeChoice />
        </div>
      </div>
      <article className="space-y-8 leading-relaxed text-muted-foreground">
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{t('title')}</h1>
          <p>
            {t.rich('lead', {
              terms: (chunks) => (
                <Link href="/terms" className="text-primary underline underline-offset-2">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </header>
        {section('account')}
        {section('kept')}
        <section aria-labelledby="privacy-out" className="space-y-3">
          <h2 id="privacy-out" className="text-xl font-semibold tracking-tight text-foreground">
            {t('out.title')}
          </h2>
          <ul className="list-disc space-y-1.5 pl-6">
            <li>{t('out.ai')}</li>
            <InstanceFacts />
            <li>{t('out.proxy')}</li>
          </ul>
        </section>
        {section('browser')}
        {section('phone')}
      </article>
    </div>
  );
}
