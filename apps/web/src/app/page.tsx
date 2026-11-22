// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import Link from 'next/link';
import { TriangleExclamationPoint } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AndroidAppCard } from '@/components/android-app-card';
import { buttonVariants } from '@/components/ui/button';
import { Brand } from '@/components/brand';
import { CatalogueSentence } from '@/components/landing/catalogue-sentence';
import { SampleDay } from '@/components/landing/sample-day';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LineDrawing } from '@/components/line-drawing';
import { ThemeChoice } from '@/components/theme-choice';

/** What the application does, each point in the person's own nouns; two of them name the instance's catalogue. */
const POINTS = ['target', 'plans', 'diary', 'counted'] as const;

/** Public landing page. */
export default function Landing() {
  const t = useTranslations('landing');
  const tCommon = useTranslations('common');
  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      {/* The name and the mark in a quiet row of their own, the language and the theme beside them. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Brand name={tCommon('appName')} size={32} className="text-lg" />
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeChoice />
        </div>
      </header>

      <section className="mt-12 grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            {t('headline')}
          </h1>
          <p className="mt-4 max-w-xl text-pretty text-lg text-muted-foreground">{t('subhead')}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/register" className={buttonVariants({ size: 'lg' })}>
              {t('getStarted')}
            </Link>
            <Link href="/login" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
              {t('signIn')}
            </Link>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">{t('facts')}</p>
        </div>
        <SampleDay />
      </section>

      {/* A pea shoot over the points and vegetables in their corner: on a phone the shoot's branch alone, as a strip. */}
      <section className="relative isolate mt-16 px-1 pb-28 pt-16 sm:mt-20 sm:px-16 sm:pb-16 sm:pt-20">
        <LineDrawing
          name="shoot-a"
          fit="top"
          className="absolute -left-1 top-0 -z-10 aspect-[16/3] w-[70%] sm:-left-6 sm:-top-8 sm:aspect-video sm:w-[min(62%,520px)]"
        />
        <LineDrawing
          name="vegetables-a"
          className="absolute -bottom-2 -right-1 -z-10 aspect-[640/476] w-[32%] sm:-bottom-6 sm:-right-6 sm:w-[min(26%,230px)]"
        />
        <h2 className="max-w-2xl text-balance text-2xl font-semibold tracking-tight">
          {t('points.title')}
        </h2>
        <dl className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {POINTS.map((point) => (
            <div key={point} className="min-w-0">
              <dt className="font-semibold">{t(`points.${point}Title`)}</dt>
              <dd className="mt-1 text-pretty text-muted-foreground">
                {point === 'plans' || point === 'counted' ? (
                  <CatalogueSentence kind={point} />
                ) : (
                  t(`points.${point}Body`)
                )}
              </dd>
            </div>
          ))}
        </dl>
        {/* True until the first release, so it stays: quieter than under the buttons, beside the vegetables. */}
        <p className="mt-12 flex max-w-md items-start gap-2 text-sm text-muted-foreground sm:max-w-[55%]">
          <TriangleExclamationPoint size={16} className="mt-0.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium text-foreground">{t('devWarning.title')}</span>{' '}
            {t('devWarning.body')}
          </span>
        </p>
      </section>

      <AndroidAppCard />
    </main>
  );
}
