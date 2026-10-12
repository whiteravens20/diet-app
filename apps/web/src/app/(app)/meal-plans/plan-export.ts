// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan } from '@diet-app/shared';
import type { Cell } from '@/lib/csv';

type Meal = MealPlan['days'][number]['meals'][number];

/** The words a plan is written out with, in the language of whoever reads it. */
export interface PlanWords {
  /** The heads of the columns: date, meal, dish, servings, kilocalories, protein, fat, carbohydrate, eaten. */
  head: readonly [string, string, string, string, string, string, string, string, string];
  meal: (type: Meal['mealType']) => string;
  /** What a meal of the user's own is called when it was given no name. */
  ownMeal: string;
  yes: string;
  no: string;
  /** What stands in the place of the meals of a day the plan skips. */
  skipped: string;
}

/** What a meal is called: the title of its recipe, or the name the user gave a meal of their own. */
export const dishOf = (meal: Meal, words: Pick<PlanWords, 'ownMeal'>): string => meal.recipe?.title ?? meal.customName ?? words.ownMeal;

/** The servings a meal is, with what a rebalance left on it. */
export const servingsOf = (meal: Meal): number => Math.round(meal.servings * meal.quantityScale * 100) / 100;

/**
 * A plan as a table for a spreadsheet: a row for each meal, under a row of
 * heads, with every number the API worked out for it. A day the plan skips
 * has one row that says so. Nothing is worked out here.
 */
export function planTable(plan: MealPlan, words: PlanWords): Cell[][] {
  return [
    [...words.head],
    ...plan.days.flatMap((day): Cell[][] =>
      day.skipped
        ? [[day.date, words.skipped, null, null, null, null, null, null, null]]
        : day.meals.map((meal) => [
            day.date,
            words.meal(meal.mealType),
            dishOf(meal, words),
            servingsOf(meal),
            meal.nutrition.calories,
            meal.nutrition.protein,
            meal.nutrition.fat,
            meal.nutrition.carbs,
            meal.eatenAt === null ? words.no : words.yes,
          ]),
    ),
  ];
}

/** The last day of a plan, as the API writes days. */
export const lastDayOf = (plan: Pick<MealPlan, 'days' | 'startDate'>): string => plan.days.at(-1)?.date ?? plan.startDate;
