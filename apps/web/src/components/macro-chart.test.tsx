// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { MacroChart } from './macro-chart';

const shown = (locale: 'en' | 'pl' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <MacroChart grams={{ protein: 150, fat: 70, carbs: 200 }} kcal={2030} />
    </NextIntlClientProvider>,
  );

describe("the ring of a day's macronutrients", () => {
  it('lists each part with its grams and its share of the energy, not of the weight', () => {
    shown();

    const items = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual(['150 gProtein · 30%', '70 gFat · 31%', '200 gCarbs · 39%']);
  });

  it("says the day's calories in its middle", () => {
    shown();

    expect(screen.getByText('2,030')).toBeInTheDocument();
  });

  it('is said in the language of the page', () => {
    shown('pl');

    expect(within(screen.getByRole('list')).getAllByRole('listitem')[0]).toHaveTextContent(
      /150\sg\s*Białko · 30%/,
    );
  });
});
