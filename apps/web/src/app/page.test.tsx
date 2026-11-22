// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import Landing from './page';
import { plain } from '@/testing/spaces';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/theme-choice', () => ({ ThemeChoice: () => null }));
// The card about the Android app reads the instance's configuration: its own test has it.
vi.mock('@/components/android-app-card', () => ({ AndroidAppCard: () => null }));
const config = vi.hoisted(() => ({
  catalogue: null as null | { recipes: number; ingredients: number },
}));
vi.mock('@/lib/use-config', () => ({
  useConfig: () => ({ data: config.catalogue ? { catalogue: config.catalogue } : undefined }),
}));

const LANGUAGES = [
  ['en', en],
  ['pl', pl],
] as const;

const show = (locale: string, messages: typeof en) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <Landing />
    </NextIntlClientProvider>,
  );

describe('the landing page', () => {
  beforeEach(() => {
    config.catalogue = null;
  });

  it.each(LANGUAGES)(
    'says in %s what a visitor can do, beside an example day of a plan',
    (locale, messages) => {
      show(locale, messages);

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        plain(messages.landing.headline),
      );
      expect(screen.getByText(plain(messages.landing.facts))).toBeInTheDocument();
      const points = messages.landing.points;
      expect(screen.getAllByRole('term').map((one) => plain(one.textContent ?? ''))).toEqual(
        [points.targetTitle, points.plansTitle, points.diaryTitle, points.countedTitle].map(plain),
      );
      const sample = messages.landing.sample;
      const day = screen.getByText(sample.label).closest('div')!.parentElement!;
      for (const meal of Object.values(sample.meals))
        expect(within(day).getByText(plain(meal))).toBeInTheDocument();
      expect(within(day).getByText(plain(sample.note))).toBeInTheDocument();
    },
  );

  it.each(LANGUAGES)(
    'names in %s how many recipes and ingredients the instance holds once its configuration is read',
    (locale, messages) => {
      config.catalogue = { recipes: 183, ingredients: 419 };
      show(locale, messages);

      const t = createTranslator({ locale, messages, namespace: 'landing.points' });
      expect(screen.getByText(plain(t('plansBody', { recipes: 183 })))).toBeInTheDocument();
      expect(screen.getByText(plain(t('countedBody', { ingredients: 419 })))).toBeInTheDocument();
    },
  );

  it.each(LANGUAGES)('says the same in %s without the numbers until then', (locale, messages) => {
    show(locale, messages);

    expect(screen.getByText(plain(messages.landing.points.plansBodyPlain))).toBeInTheDocument();
    expect(screen.getByText(plain(messages.landing.points.countedBodyPlain))).toBeInTheDocument();
  });
});
