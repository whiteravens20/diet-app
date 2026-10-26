// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Metadata } from 'next';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeChoice } from '@/components/theme-choice';
import { termsFor } from '@/lib/terms';
import { SOFTWARE_NOTICE_ID, SoftwareNotice } from './software-notice';

export const metadata: Metadata = {
  title: 'Terms of Service — Diet App',
};

/**
 * The operator's terms of service, in the language of the page where they wrote it in
 * that language, and under them what the application says of itself, which no operator
 * can leave out. The terms are HTML the server made from the operator's Markdown
 * (`lib/terms.ts`), with raw HTML shown as text and unsafe addresses dropped.
 */
export default function TermsPage() {
  const t = useTranslations('terms');
  const terms = termsFor(useLocale());

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:flex-row">
      <aside className="lg:sticky lg:top-10 lg:h-fit lg:w-56 lg:shrink-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeChoice />
          </div>
        </div>
        <nav aria-label={t('toc')} className="hidden text-sm lg:block">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('toc')}
          </p>
          <ol className="space-y-1.5">
            {terms.outline.map(({ id, title }) => (
              <li key={id}>
                <a href={`#${id}`} className="text-muted-foreground hover:text-foreground">
                  {title}
                </a>
              </li>
            ))}
            <li>
              <a
                href={`#${SOFTWARE_NOTICE_ID}`}
                className="text-muted-foreground hover:text-foreground"
              >
                {t('software.title')}
              </a>
            </li>
          </ol>
        </nav>
      </aside>

      <div className="min-w-0 flex-1 space-y-10">
        <article
          className="space-y-4 leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:rounded-md [&_blockquote]:border [&_blockquote]:border-warning/40 [&_blockquote]:bg-warning/10 [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-foreground [&_h2]:scroll-mt-10 [&_h2]:pt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:pt-2 [&_h3]:font-semibold [&_h3]:text-foreground [&_hr]:border-border [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6 [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6"
          // Made on the server from the operator's own files: see lib/terms.ts.
          dangerouslySetInnerHTML={{ __html: terms.html }}
        />
        <SoftwareNotice />
      </div>
    </div>
  );
}
