// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { CookingChange, MealPlan, PlannedMeal } from '@diet-app/shared';
import { MEAL_SLOTS_BY_COUNT } from '@diet-app/shared/constants';
import { useFormat } from '@/lib/use-format';

/** The meals of a day in the order they are eaten. */
const EATEN_IN_ORDER: readonly string[] = MEAL_SLOTS_BY_COUNT[5]!;

type Weekday = '0' | '1' | '2' | '3' | '4' | '5' | '6';

/** A calendar day's weekday, by the same reckoning wherever it is read. */
const weekdayOf = (date: string): Weekday =>
  String(new Date(`${date}T00:00:00Z`).getUTCDay()) as Weekday;

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

type Cooked = Pick<PlannedMeal, 'cookAhead' | 'cooking' | 'mealType'>;
type Place = NonNullable<PlannedMeal['cooking']>['with'][number];

/**
 * The meal of its cooking that a mark speaks of: for a meal cooked earlier the
 * one it was cooked at, which comes first; for the one to cook a meal of
 * another day where there is one, as the day says more than the meal.
 */
const partner = (meal: Cooked, date: string): Place | null => {
  if (!meal.cookAhead || !meal.cooking) return null;
  const others = meal.cooking.with;
  return (
    (meal.cookAhead === 'cook' && others.find((one) => one.date !== date)) || others[0] || null
  );
};

/** How many servings a meal comes to, as a person reads it. */
const servingsOf = (meal: Pick<PlannedMeal, 'servings' | 'quantityScale'>): number =>
  meal.servings * meal.quantityScale;

const shown = (servings: number): number => Math.round(servings * 10) / 10;

/** What a meal opened from a plan takes: of this meal alone, or of the whole of a dish to cook now. */
export interface MealPortion {
  servings: number;
  whole: boolean;
}

/** The amounts to cook of a meal, and how many servings they are: the meal to cook gives those of all its cooking. */
export function toCook(plan: MealPlan, meal: PlannedMeal) {
  if (meal.cookAhead !== 'cook' || !meal.cooking)
    return {
      amounts: meal.ingredients,
      portion: { servings: shown(servingsOf(meal)), whole: false },
    };
  const others = meal.cooking.with.map((other) => other.mealId);
  const meals = plan.days.flatMap((day) => day.meals).filter((one) => others.includes(one.id));
  return {
    amounts: meal.cooking.ingredients,
    portion: {
      servings: shown(meals.reduce((sum, one) => sum + servingsOf(one), servingsOf(meal))),
      whole: true,
    },
  };
}

/** The meals one cooking is eaten at, in the plan's order, with their days: what a dish cooked ahead is split into. None for a meal that is not cooked ahead. */
export function mealsOfCooking(
  plan: MealPlan,
  meal: PlannedMeal,
): { meal: PlannedMeal; date: string }[] {
  if (meal.cookAhead !== 'cook' || !meal.cooking) return [];
  const ids = new Set([meal.id, ...meal.cooking.with.map((other) => other.mealId)]);
  return plan.days.flatMap((day) =>
    day.meals.filter((one) => ids.has(one.id)).map((one) => ({ meal: one, date: day.date })),
  );
}

/** What is said of a meal cooked with another: the day or the meal it comes from, by name. */
export function useCookingWords() {
  const t = useTranslations('mealPlans.cooking');
  const dayFrom = (date: string): string => t(`dayFrom.${weekdayOf(date)}`);
  const dayFor = (date: string): string => t(`dayFor.${weekdayOf(date)}`);
  const dayOn = (date: string): string => t(`dayOn.${weekdayOf(date)}`);
  return {
    /** The mark on the meal, for a day of `date`. */
    chip(meal: Cooked, date: string): string | null {
      const other = partner(meal, date);
      if (!other) return null;
      if (meal.cookAhead === 'cook') return t(other.date === date ? 'cookMeals' : 'cookDays');
      return capitalised(
        other.date === date ? t(`mealFrom.${other.mealType}`) : dayFrom(other.date),
      );
    },
    /** What the mark means, under the meal. */
    hint(meal: Cooked, date: string): string | null {
      const other = partner(meal, date);
      if (!other) return null;
      const oneDay = other.date === date;
      if (meal.cookAhead === 'cook') {
        return t('cookHint', {
          first: oneDay ? t(`mealFor.${meal.mealType}`) : dayFor(date),
          second: oneDay ? t(`mealFor.${other.mealType}`) : dayFor(other.date),
        });
      }
      return t('fromHint', {
        from: oneDay ? t(`mealFrom.${other.mealType}`) : dayFrom(other.date),
      });
    },
    /** What to do where the day the dish was to be cooked on is over and nothing says it was. */
    notCooked(meal: Cooked, date: string, today: string): string | null {
      const other = partner(meal, date);
      if (meal.cookAhead !== 'cooked' || !other || other.eaten) return null;
      return other.date < today && date >= today
        ? t('notCooked', { when: dayOn(other.date) })
        : null;
    },
    /** What follows for the other meal when this one leaves the cooking. */
    apart(meal: Cooked, date: string, today: string): string | null {
      // Of a dish cooked for more than two meals, the rest are cooked once all the same.
      const other = meal.cooking?.with[0];
      if (!meal.cookAhead || !other || other.eaten || other.date < today) return null;
      if (meal.cookAhead === 'cooked' && meal.cooking!.with.length > 1) return null;
      const when = capitalised(
        other.date === date ? t(`mealOn.${other.mealType}`) : dayOn(other.date),
      );
      return t(meal.cookAhead === 'cook' ? 'cooksSeparately' : 'cooksForOne', { when });
    },
  };
}

/**
 * What a change of a dish does to the other meals of its cooking, said before
 * the choice, with the tick that keeps it to what was asked for.
 */
export function CookingNote({
  change,
  only,
  onOnly,
  label,
  mealName,
}: {
  change: CookingChange;
  only: boolean;
  onOnly: (only: boolean) => void;
  /** What the tick is called: this day only, or the days chosen. */
  label: 'only' | 'onlyChosen';
  mealName: (mealType: string) => string;
}) {
  const t = useTranslations('mealPlans.cooking');
  const fmt = useFormat();
  if (!change) return null;
  const places = (meals: NonNullable<CookingChange>['changes']): string =>
    fmt.list(
      [...meals]
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            EATEN_IN_ORDER.indexOf(a.mealType) - EATEN_IN_ORDER.indexOf(b.mealType),
        )
        .map(({ date, mealType }) => `${fmt.weekday(date)} ${mealName(mealType).toLowerCase()}`),
    );
  return (
    <div className="space-y-1">
      {change.changes.length > 0 && (
        <>
          {!only && <p>{t('alsoChanges', { places: places(change.changes) })}</p>}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={only}
              onChange={(e) => onOnly(e.target.checked)}
            />
            {t(label)}
          </label>
        </>
      )}
      {change.stays.length > 0 && (
        <p className="text-muted-foreground">
          {t('staysUnused', { places: places(change.stays) })}
        </p>
      )}
    </div>
  );
}
