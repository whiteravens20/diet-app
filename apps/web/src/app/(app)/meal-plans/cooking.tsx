// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type {
  CookingChange,
  MealPlan,
  MealType,
  PlannedIngredient,
  PlannedMeal,
} from '@diet-app/shared';
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

/** A line of a dish the two people of a joint plan eat on plates of their own: what each plate takes of it, as it is shown. */
export interface PlateRow {
  ingredientId: string;
  name: string;
  mine: PlannedIngredient['display'];
  theirs: PlannedIngredient['display'];
}

/**
 * The portions of a dish the two people of a joint plan cook in one pot: this
 * plan's, and the other's by their name, with the lines a plate of either takes
 * otherwise than the recipe has it (`platesOf`).
 */
export interface PotPortions {
  mine: number;
  name: string;
  theirs: number;
  plates: PlateRow[];
}

/**
 * The lines of a dish both people eat that a plate of either holds otherwise
 * than the recipe's proportion: what each plate takes of them. None where both
 * plates are the recipe's, and for a meal of one plan alone.
 */
export function platesOf(meal: Pick<PlannedMeal, 'ingredients' | 'shared'>): PlateRow[] {
  const theirs = meal.shared?.with.ingredients ?? [];
  return meal.ingredients.flatMap((line, index) => {
    const other = theirs[index];
    if (!other || other.ingredientId !== line.ingredientId) return [];
    if (line.share === undefined && other.share === undefined) return [];
    return [
      {
        ingredientId: line.ingredientId,
        name: line.name,
        mine: line.display,
        theirs: other.display,
      },
    ];
  });
}

/**
 * What a meal the two people of a joint plan cook in one pot is opened with:
 * what the pot takes, both portions together, of both cookings where the dish
 * is cooked ahead. Nothing for any other meal, and for one cooked apart.
 */
export function toCookTogether(
  plan: MealPlan,
  meal: PlannedMeal,
):
  | { amounts: PlannedMeal['ingredients']; portion: MealPortion; pot: PotPortions }
  | Record<string, never> {
  // A leftover was cooked with the meal it was left of: there is no pot for it.
  if (!meal.shared || meal.shared.apart || meal.leftover) return {};
  const cooked =
    meal.cookAhead === 'cook' && meal.cooking
      ? mealsOfCooking(plan, meal).map((one) => one.meal)
      : [meal];
  const mine = cooked.reduce((sum, one) => sum + servingsOf(one), 0);
  const theirs = cooked.reduce((sum, one) => sum + (one.shared?.with.servings ?? 0), 0);
  return {
    amounts: meal.shared.pot,
    portion: { servings: shown(mine + theirs), whole: true },
    pot: {
      mine: shown(mine),
      name: meal.shared.with.profileName,
      theirs: shown(theirs),
      // The plates of one meal: a pot cooked for several holds as many plates of each.
      plates: cooked.length === 1 ? platesOf(meal) : [],
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
  const tLeft = useTranslations('mealPlans.leftover');
  const dayFrom = (date: string): string => t(`dayFrom.${weekdayOf(date)}`);
  const dayFor = (date: string): string => t(`dayFor.${weekdayOf(date)}`);
  const dayOn = (date: string): string => t(`dayOn.${weekdayOf(date)}`);
  return {
    /** When a meal of `date` at `mealType` is eaten, as a sentence says it: "on Wednesday for lunch". */
    on: (date: string, mealType: MealType): { day: string; meal: string } => ({
      day: dayOn(date),
      meal: t(`mealOn.${mealType}`),
    }),
    /** The mark of a leftover: the day it was left on. */
    leftoverChip(meal: Pick<PlannedMeal, 'leftover'>): string | null {
      return meal.leftover ? capitalised(dayFrom(meal.leftover.date)) : null;
    },
    /** What a leftover is, under it; or, under the meal it was left of, where its rest is eaten. */
    leftoverHint(meal: Pick<PlannedMeal, 'leftover' | 'carriedTo'>): string | null {
      if (meal.leftover)
        return tLeft('fromHint', {
          meal: tLeft(`mealOf.${meal.leftover.mealType}`),
          from: dayFrom(meal.leftover.date),
        });
      if (meal.carriedTo)
        return tLeft('carriedHint', {
          day: dayOn(meal.carriedTo.date),
          meal: t(`mealOn.${meal.carriedTo.mealType}`),
        });
      return null;
    },
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
