import type { Metadata } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/language-switcher';

const LAST_UPDATED = '2026-06-02';

const SECTION_KEYS = [
  'section1',
  'section2',
  'section3',
  'section4',
  'section5',
  'section6',
  'section7',
  'section8',
  'section9',
] as const;
const CONTACT_KEY = 'section10';

export const metadata: Metadata = {
  title: 'Terms of Service — Diet App',
};

export default function TermsPage() {
  const t = useTranslations('terms');
  const operatorContact = process.env.NEXT_PUBLIC_OPERATOR_CONTACT;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:flex-row">
      <aside className="lg:sticky lg:top-10 lg:h-fit lg:w-56 lg:shrink-0">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
          <LanguageSwitcher />
        </div>
        <nav aria-label={t('toc')} className="hidden text-sm lg:block">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('toc')}
          </p>
          <ol className="space-y-1.5">
            {SECTION_KEYS.map((key, idx) => (
              <li key={key}>
                <a
                  href={`#${key}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {idx + 1}. {t(`${key}.title`)}
                </a>
              </li>
            ))}
            <li>
              <a
                href={`#${CONTACT_KEY}`}
                className="text-muted-foreground hover:text-foreground"
              >
                {SECTION_KEYS.length + 1}. {t(`${CONTACT_KEY}.title`)}
              </a>
            </li>
          </ol>
        </nav>
      </aside>

      <article className="flex-1 space-y-8">
        <header className="space-y-2 border-b border-border/60 pb-4">
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('lastUpdated', { date: LAST_UPDATED })}
          </p>
        </header>

        {SECTION_KEYS.map((key, idx) => (
          <section key={key} id={key} className="space-y-3 scroll-mt-10">
            <h2 className="text-xl font-semibold tracking-tight">
              {idx + 1}. {t(`${key}.title`)}
            </h2>
            <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
              {t(`${key}.body`)}
            </p>
          </section>
        ))}

        <section id={CONTACT_KEY} className="space-y-3 scroll-mt-10">
          <h2 className="text-xl font-semibold tracking-tight">
            {SECTION_KEYS.length + 1}. {t(`${CONTACT_KEY}.title`)}
          </h2>
          <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
            {t(`${CONTACT_KEY}.body`)}
          </p>
          {operatorContact ? (
            <p>
              <a
                href={`mailto:${operatorContact}`}
                className="text-primary underline-offset-2 hover:underline"
              >
                {operatorContact}
              </a>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/70">
              {t(`${CONTACT_KEY}.operatorNotSet`)}
            </p>
          )}
        </section>
      </article>
    </div>
  );
}
