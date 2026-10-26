// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import Link from 'next/link';
import {
  CalendarRange,
  CodeXml,
  Cpu,
  ListChecks,
  Server,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Utensils,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeChoice } from '@/components/theme-choice';

const FEATURE_KEYS = [
  { icon: SlidersHorizontal, titleKey: 'controlTitle', bodyKey: 'controlBody' },
  { icon: CalendarRange, titleKey: 'plansTitle', bodyKey: 'plansBody' },
  { icon: Shuffle, titleKey: 'swapsTitle', bodyKey: 'swapsBody' },
  { icon: ListChecks, titleKey: 'listsTitle', bodyKey: 'listsBody' },
  { icon: Utensils, titleKey: 'nutritionTitle', bodyKey: 'nutritionBody' },
  { icon: Sparkles, titleKey: 'aiTitle', bodyKey: 'aiBody' },
] as const;

// Pills shown above the headline. Each keeps a distinct icon — self-hosted
// uses Server (not Sparkles, which the AI feature card owns).
const HIGHLIGHT_KEYS = [
  { icon: Server, key: 'selfHosted' },
  { icon: ShieldCheck, key: 'privacy' },
  { icon: CodeXml, key: 'openSource' },
  { icon: Cpu, key: 'aiOptional' },
] as const;

/** Public landing page. */
export default function Landing() {
  const t = useTranslations('landing');
  const tFeatures = useTranslations('landing.features');
  return (
    <main className="mx-auto max-w-5xl px-6 py-20">
      <div className="flex items-center justify-end gap-2">
        <LanguageSwitcher />
        <ThemeChoice />
      </div>
      <section className="mt-6 text-center">
        <div className="flex flex-wrap justify-center gap-2">
          {HIGHLIGHT_KEYS.map((h) => (
            <span
              key={h.key}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground"
            >
              <h.icon size={13} /> {t(`highlights.${h.key}`)}
            </span>
          ))}
        </div>
        <h1 className="mt-6 text-balance text-5xl font-semibold tracking-tight">{t('headline')}</h1>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-lg text-muted-foreground">
          {t('subhead')}
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/register" className={buttonVariants({ size: 'lg' })}>
            {t('getStarted')}
          </Link>
          <Link href="/login" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
            {t('signIn')}
          </Link>
        </div>
        <div className="mx-auto mt-8 flex max-w-xl items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-left text-sm text-warning">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">{t('devWarning.title')}</span> {t('devWarning.body')}
          </p>
        </div>
      </section>

      <section className="mt-20 grid gap-4 sm:grid-cols-2">
        {FEATURE_KEYS.map((f) => (
          <Card key={f.titleKey} className="p-6">
            <span className="inline-flex rounded-md bg-muted p-2 text-primary">
              <f.icon size={20} />
            </span>
            <h3 className="mt-3 font-semibold">{tFeatures(f.titleKey)}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{tFeatures(f.bodyKey)}</p>
          </Card>
        ))}
      </section>
    </main>
  );
}
