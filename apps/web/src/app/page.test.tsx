// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import Landing from './page';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/theme-choice', () => ({ ThemeChoice: () => null }));

describe('the landing page', () => {
  it.each([
    ['en', en],
    ['pl', pl],
  ] as const)(
    'says in %s what a visitor can do with their plan, above what the app has',
    (locale, messages) => {
      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Landing />
        </NextIntlClientProvider>,
      );

      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent(messages.landing.yours.title);
      expect(screen.getByText(messages.landing.yours.body)).toBeInTheDocument();
      const features = messages.landing.features;
      expect(screen.getAllByRole('heading', { level: 3 }).map((one) => one.textContent)).toEqual([
        features.controlTitle,
        features.plansTitle,
        features.diaryTitle,
        features.listsTitle,
        features.nutritionTitle,
        features.aiTitle,
      ]);
    },
  );
});
