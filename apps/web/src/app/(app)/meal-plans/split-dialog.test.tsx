// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { MealPlan, PlannedIngredient, PlannedMeal } from '@diet-app/shared';
import en from '../../../../messages/en.json';
import { mealsOfCooking } from './cooking';
import { partsOfPot, SplitDialog, type PotPart } from './split-dialog';

const line = (ingredientId: string, quantity: number, share?: number): PlannedIngredient => ({
  ingredientId,
  name: ingredientId,
  quantity,
  unit: 'g',
  display: { quantity, unit: 'g' },
  note: null,
  ...(share !== undefined ? { share } : {}),
});

const meal = (id: string, over: Partial<PlannedMeal> = {}) =>
  ({
    id,
    mealType: 'lunch',
    cookAhead: null,
    cooking: null,
    shared: null,
    pot: null,
    eatenAt: null,
    servings: 1,
    quantityScale: 1,
    nutrition: { calories: 600, protein: 40, fat: 20, carbs: 60 },
    ingredients: [line('chicken', 150), line('rice', 80)],
    ...over,
  }) as PlannedMeal;

/** A stew cooked on Monday for Monday's lunch and Tuesday's. */
const cooked = (monday: Partial<PlannedMeal> = {}, tuesday: Partial<PlannedMeal> = {}) => {
  const cook = meal('monday', {
    cookAhead: 'cook',
    cooking: {
      with: [{ mealId: 'tuesday', date: '2026-01-06', mealType: 'lunch', eaten: false }],
      ingredients: [],
    },
    ...monday,
  });
  const later = meal('tuesday', { cookAhead: 'cooked', ...tuesday });
  const plan = {
    days: [
      { date: '2026-01-05', meals: [cook] },
      { date: '2026-01-06', meals: [later] },
    ],
  } as MealPlan;
  return { plan, cook };
};

describe('what a dish is split into', () => {
  it('is every meal of its cooking while none is eaten, with nothing left in the pot', () => {
    const { plan, cook } = cooked();

    const parts = partsOfPot(mealsOfCooking(plan, cook), 'Me');
    expect(parts.split.map((part) => part.key)).toEqual(['monday', 'tuesday']);
    expect(parts.eaten).toEqual([]);
    expect(parts.rest).toBeNull();
    expect(parts.plated).toBe(false);
  });

  it('leaves out a portion eaten already, named, and adds what the pot holds beyond the meals of now', () => {
    // Monday's lunch was eaten; Tuesday's was sized down to 0.75 after the pot was cooked for 1: a quarter stays.
    const { plan, cook } = cooked(
      { eatenAt: '2026-01-05T12:00:00.000Z' },
      {
        quantityScale: 0.75,
        nutrition: { calories: 450, protein: 30, fat: 15, carbs: 45 },
        ingredients: [line('chicken', 112.5), line('rice', 60)],
        pot: { cookedOn: '2026-01-05', cooked: 1, rest: 0.25, held: false, offer: 'ok' },
      },
    );

    const parts = partsOfPot(mealsOfCooking(plan, cook), 'Me');
    expect(parts.split.map((part) => part.key)).toEqual(['tuesday']);
    expect(parts.eaten.map((part) => part.key)).toEqual(['monday']);
    // A quarter of a serving of what a serving of Tuesday's lunch holds.
    expect(parts.rest!.kcal).toBeCloseTo(150);
    expect(parts.rest!.lines).toEqual([
      { ingredientId: 'chicken', name: 'chicken', quantity: 37.5 },
      { ingredientId: 'rice', name: 'rice', quantity: 20 },
    ]);
  });

  it('is both portions of a pot both cook, the other person’s by their name, and plated where a plate differs', () => {
    const own = meal('mine', {
      ingredients: [line('chicken', 156, 1.3), line('rice', 48, 0.8)],
      shared: {
        id: 'shared',
        apart: false,
        with: {
          mealId: 'hers',
          planId: 'plan-2',
          profileName: 'Ewa',
          servings: 1,
          calories: 500,
          eaten: true,
          ingredients: [line('chicken', 84, 0.7), line('rice', 72, 1.2)],
        },
        pot: [],
      },
    });
    const parts = partsOfPot([{ meal: own, date: '2026-01-05' }], 'Me');
    expect(parts.split.map((part) => [part.key, part.who])).toEqual([['mine', 'Me']]);
    expect(parts.eaten.map((part) => [part.key, part.who])).toEqual([['hers', 'Ewa']]);
    expect(parts.plated).toBe(true);
  });
});

describe('the window a dish is split in', () => {
  // The page names the portions: here by their day and time of day, as the plan's page does in English.
  const words = {
    label: (part: PotPart) =>
      `${part.date === '2026-01-05' ? 'Monday' : 'Tuesday'}, ${part.mealType}`,
    list: (items: readonly string[]) => items.join(' and '),
  };
  const opened = (plan: MealPlan, cook: PlannedMeal) =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SplitDialog
          cooked={mealsOfCooking(plan, cook)}
          ownName="Me"
          words={words}
          onClose={() => {}}
        />
      </NextIntlClientProvider>,
    );

  it('names the portions it leaves out as eaten, and splits the rest with what stays in the pot', () => {
    const { plan, cook } = cooked(
      { eatenAt: '2026-01-05T12:00:00.000Z' },
      { pot: { cookedOn: '2026-01-05', cooked: 1.25, rest: 0.25, held: false, offer: 'ok' } },
    );
    opened(plan, cook);

    expect(
      screen.getByText(/^Leaving out the portions eaten already: Monday, lunch\.$/),
    ).toBeVisible();
    expect(screen.getByText('Tuesday, lunch')).toBeVisible();
    expect(screen.getByText(en.split.restInPot)).toBeVisible();
    expect(screen.queryByText('Monday, lunch')).toBeNull();
  });

  it('says there is nothing left to split once every portion is eaten', () => {
    const { plan, cook } = cooked(
      { eatenAt: '2026-01-05T12:00:00.000Z' },
      { eatenAt: '2026-01-06T12:00:00.000Z' },
    );
    opened(plan, cook);

    expect(screen.getByText(en.split.allEaten)).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
