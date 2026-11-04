// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CookingChange, MealPlan, PlannedMeal } from '@diet-app/shared';
import en from '../../../../messages/en.json';
import pl from '../../../../messages/pl.json';
import { CookingNote, toCook, useCookingWords } from './cooking';

const TUESDAY = '2026-01-06';
const WEDNESDAY = '2026-01-07';

const inPolish = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="pl" messages={pl}>
    {children}
  </NextIntlClientProvider>
);
const inEnglish = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {children}
  </NextIntlClientProvider>
);

type Place = NonNullable<PlannedMeal['cooking']>['with'][number];
const place = (over: Partial<Place> = {}): Place => ({
  mealId: 'other',
  date: WEDNESDAY,
  mealType: 'lunch',
  eaten: false,
  ...over,
});
const aMeal = (cookAhead: 'cook' | 'cooked', ...others: Place[]) =>
  ({
    cookAhead,
    mealType: 'lunch',
    cooking: { with: others, ingredients: [] },
  }) as Pick<PlannedMeal, 'cookAhead' | 'mealType' | 'cooking'>;

describe('what is said in Polish of a meal cooked with another', () => {
  const words = () => renderHook(() => useCookingWords(), { wrapper: inPolish }).result.current;

  it('names the two days of a dish cooked once', () => {
    const { chip, hint } = words();
    const meal = aMeal('cook', place());

    expect(chip(meal, TUESDAY)).toBe('Ugotuj na 2 dni');
    expect(hint(meal, TUESDAY)).toBe('Gotujesz raz, na wtorek i środę.');
  });

  it('names the two meals of a dish cooked for one day', () => {
    const { chip, hint } = words();
    const meal = aMeal('cook', place({ date: TUESDAY, mealType: 'dinner' }));

    expect(chip(meal, TUESDAY)).toBe('Ugotuj na 2 posiłki');
    expect(hint(meal, TUESDAY)).toBe('Gotujesz raz, na obiad i kolację.');
  });

  it('says of the meal eaten from it which day that dish is from, by every weekday', () => {
    const { chip, hint } = words();
    const from = [
      ['2026-01-05', 'Z poniedziałku', 'z poniedziałku'],
      ['2026-01-06', 'Z wtorku', 'z wtorku'],
      ['2026-01-07', 'Ze środy', 'ze środy'],
      ['2026-01-08', 'Z czwartku', 'z czwartku'],
      ['2026-01-09', 'Z piątku', 'z piątku'],
      ['2026-01-10', 'Z soboty', 'z soboty'],
      ['2026-01-11', 'Z niedzieli', 'z niedzieli'],
    ] as const;
    for (const [date, name, inText] of from) {
      const meal = aMeal('cooked', place({ date }));
      expect(chip(meal, '2026-02-01')).toBe(name);
      expect(hint(meal, '2026-02-01')).toBe(`Nie gotujesz: to reszta dania ${inText}.`);
    }
  });

  it('says of the meal eaten from it which meal of the day that dish is from', () => {
    const { chip, hint } = words();
    const from = [
      ['breakfast', 'Ze śniadania', 'ze śniadania'],
      ['second_breakfast', 'Z drugiego śniadania', 'z drugiego śniadania'],
      ['lunch', 'Z obiadu', 'z obiadu'],
      ['snack', 'Z przekąski', 'z przekąski'],
      ['dinner', 'Z kolacji', 'z kolacji'],
    ] as const;
    for (const [mealType, name, inText] of from) {
      const meal = aMeal('cooked', place({ date: TUESDAY, mealType }));
      expect(chip(meal, TUESDAY)).toBe(name);
      expect(hint(meal, TUESDAY)).toBe(`Nie gotujesz: to reszta dania ${inText}.`);
    }
  });

  it('speaks of the next day where a dish is cooked for a second meal of its day and for the next as well', () => {
    const { chip, hint } = words();
    const meal = aMeal('cook', place({ date: TUESDAY, mealType: 'dinner' }), place());

    expect(chip(meal, TUESDAY)).toBe('Ugotuj na 2 dni');
    expect(hint(meal, TUESDAY)).toBe('Gotujesz raz, na wtorek i środę.');
  });

  it('tells what to do where the day of the cooking is over and nothing says it was eaten', () => {
    const { notCooked } = words();

    const fromTuesday = aMeal('cooked', place({ date: TUESDAY }));
    expect(notCooked(fromTuesday, WEDNESDAY, WEDNESDAY)).toBe(
      'Jeśli we wtorek nie było gotowania, ugotuj dziś: ilości są dla tego posiłku.',
    );
    // It was eaten: it was cooked.
    expect(
      notCooked(aMeal('cooked', place({ date: TUESDAY, eaten: true })), WEDNESDAY, WEDNESDAY),
    ).toBeNull();
    // Tuesday has not passed yet.
    expect(notCooked(fromTuesday, WEDNESDAY, TUESDAY)).toBeNull();
    // Both are over: there is nothing left to do about it.
    expect(notCooked(fromTuesday, WEDNESDAY, '2026-01-08')).toBeNull();
    expect(notCooked(aMeal('cook', place()), TUESDAY, WEDNESDAY)).toBeNull();
  });

  it('says what follows for the other meal where one leaves the cooking', () => {
    const { apart } = words();

    expect(apart(aMeal('cook', place()), TUESDAY, TUESDAY)).toBe(
      'W środę to danie ugotujesz osobno.',
    );
    expect(apart(aMeal('cooked', place({ date: TUESDAY })), WEDNESDAY, TUESDAY)).toBe(
      'We wtorek gotujesz na jeden posiłek.',
    );
    expect(
      apart(aMeal('cook', place({ date: TUESDAY, mealType: 'dinner' })), TUESDAY, TUESDAY),
    ).toBe('Na kolację to danie ugotujesz osobno.');
    expect(apart(aMeal('cooked', place({ date: TUESDAY })), TUESDAY, TUESDAY)).toBe(
      'Na obiad gotujesz na jeden posiłek.',
    );
  });

  it('has nothing to say of the other meal where it is over, was eaten, or the rest are cooked once all the same', () => {
    const { apart } = words();

    expect(apart(aMeal('cooked', place({ date: TUESDAY })), WEDNESDAY, WEDNESDAY)).toBeNull();
    expect(apart(aMeal('cook', place({ eaten: true })), TUESDAY, TUESDAY)).toBeNull();
    expect(
      apart(aMeal('cooked', place({ date: TUESDAY }), place()), WEDNESDAY, TUESDAY),
    ).toBeNull();
  });

  it('says nothing of a meal cooked for itself', () => {
    const { chip, hint, notCooked, apart } = words();
    const meal = { cookAhead: null, mealType: 'lunch', cooking: null } as const;

    expect(chip(meal, TUESDAY)).toBeNull();
    expect(hint(meal, TUESDAY)).toBeNull();
    expect(notCooked(meal, TUESDAY, TUESDAY)).toBeNull();
    expect(apart(meal, TUESDAY, TUESDAY)).toBeNull();
  });
});

describe('what is said in English of a meal cooked with another', () => {
  it('says the same', () => {
    const { chip, hint, notCooked, apart } = renderHook(() => useCookingWords(), {
      wrapper: inEnglish,
    }).result.current;

    expect(chip(aMeal('cook', place()), TUESDAY)).toBe('Cook for 2 days');
    expect(hint(aMeal('cook', place()), TUESDAY)).toBe('You cook once, for Tuesday and Wednesday.');
    expect(chip(aMeal('cooked', place({ date: TUESDAY })), WEDNESDAY)).toBe('From Tuesday');
    expect(hint(aMeal('cooked', place({ date: TUESDAY })), WEDNESDAY)).toBe(
      'No cooking: this is the rest of the dish from Tuesday.',
    );
    expect(notCooked(aMeal('cooked', place({ date: TUESDAY })), WEDNESDAY, WEDNESDAY)).toBe(
      'If there was no cooking on Tuesday, cook today: the amounts are for this meal.',
    );
    expect(apart(aMeal('cook', place()), TUESDAY, TUESDAY)).toBe(
      'On Wednesday you cook this dish separately.',
    );
  });
});

describe('what a meal takes to cook', () => {
  const line = (quantity: number) => ({ quantity }) as PlannedMeal['ingredients'][number];
  const meal = (over: Partial<PlannedMeal>) =>
    ({
      id: 'this',
      servings: 1.25,
      quantityScale: 1,
      ingredients: [line(100)],
      cookAhead: null,
      cooking: null,
      ...over,
    }) as PlannedMeal;
  const planOf = (...meals: PlannedMeal[]) => ({ days: [{ meals }] }) as MealPlan;

  it('is what the meal itself holds, for a meal cooked for itself or eaten from what was cooked', () => {
    const own = meal({
      cookAhead: 'cooked',
      cooking: { with: [place()], ingredients: [line(250)] },
    });

    expect(toCook(planOf(own), own)).toEqual({
      amounts: [line(100)],
      portion: { servings: 1.3, whole: false },
    });
  });

  it('is what the whole of the cooking takes, for the meal it is cooked at', () => {
    const first = meal({
      cookAhead: 'cook',
      cooking: { with: [place({ mealId: 'second' })], ingredients: [line(250)] },
    });
    const second = meal({ id: 'second', servings: 1.5, quantityScale: 0.9 });

    expect(toCook(planOf(first, second), first)).toEqual({
      amounts: [line(250)],
      portion: { servings: 2.6, whole: true },
    });
  });
});

describe('the note on what else a change of a dish changes', () => {
  const note = (change: CookingChange, only = false) => {
    const onOnly = vi.fn();
    render(
      <NextIntlClientProvider locale="pl" messages={pl}>
        <CookingNote
          change={change}
          only={only}
          onOnly={onOnly}
          label="only"
          mealName={(mealType) => (mealType === 'lunch' ? 'Obiad' : 'Kolacja')}
        />
      </NextIntlClientProvider>,
    );
    return onOnly;
  };
  const wednesday = { date: WEDNESDAY, mealType: 'lunch' } as const;

  it('says what changes too, and lets it be kept to this day', async () => {
    const onOnly = note({ changes: [wednesday], stays: [] });

    expect(screen.getByText('Zmieni się też: śr. obiad.')).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tylko ten dzień' }));
    expect(onOnly).toHaveBeenCalledWith(true);
  });

  it('no longer says so once it is kept to this day', () => {
    note({ changes: [wednesday], stays: [] }, true);

    expect(screen.queryByText(/Zmieni się też/)).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Tylko ten dzień' })).toBeChecked();
  });

  it('says that a portion goes unused where the other meal stays, and offers no tick', () => {
    note({ changes: [], stays: [{ date: TUESDAY, mealType: 'dinner' }] });

    expect(
      screen.getByText(
        'Bez zmian zostaje: wt. kolacja. Ugotowana na to porcja zostanie niewykorzystana.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says nothing of a meal with no other of its cooking', () => {
    note(null);

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Zmieni się też/)).toBeNull();
  });
});
