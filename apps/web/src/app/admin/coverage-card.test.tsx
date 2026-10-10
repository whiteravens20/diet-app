// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { DietType, MealType } from '@diet-app/shared';
import type { AdminStats } from '@/lib/admin-api';
import messages from '../../../messages/en.json';
import { CoverageCard } from './coverage-card';

const coverage = Object.fromEntries(
  DietType.options.map((diet) => [diet, Object.fromEntries(MealType.options.map((meal) => [meal, 12]))]),
) as AdminStats['coverage'];
coverage.vegan = { breakfast: 4, second_breakfast: 0, lunch: 2, snack: 3, dinner: 7 };

function renderCard() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoverageCard coverage={coverage} />
    </NextIntlClientProvider>,
  );
}

describe('the administrator\'s table of recipes per diet and meal', () => {
  it('has the meals in the order of a day and a row for every diet', () => {
    renderCard();

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Diet',
      'Breakfast',
      'Second breakfast',
      'Lunch',
      'Snack',
      'Dinner',
    ]);
    expect(screen.getAllByRole('rowheader')).toHaveLength(DietType.options.length);
  });

  it('gives each diet its count for each meal', () => {
    renderCard();

    const row = screen.getByRole('row', { name: /^Vegan/ });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['4', '0', '2', '3', '7']);
  });

  it('sets apart a meal with no recipe from one with few and one with enough', () => {
    renderCard();

    const [enough, none, few] = within(screen.getByRole('row', { name: /^Vegan/ })).getAllByRole('cell');
    expect(none!.className).toContain('text-destructive');
    expect(few!.className).toContain('text-amber-600');
    expect(enough!.className).not.toMatch(/text-destructive|text-amber/);
  });
});
