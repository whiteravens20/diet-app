// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What a day of a plan and its meals carry of their own, as it is kept with them and read back. */
import type { MealType } from '@diet-app/shared';

/**
 * Persisted per-day overrides. The resolved per-day calorie target lives in
 * the `MealPlanDay.calorieTarget` column (so swap, favorite-set apply and the
 * rebalancer read it unchanged); this JSON carries the raw advanced inputs + semantics needed to
 * re-roll the day and to render it. `calorieTarget` is stored here only when it
 * was an explicit override, so `regenerate` can pick up profile changes for
 * non-overridden days while preserving deliberate per-day targets.
 */
export type DayOverridesJson = {
  mealCount?: number;
  calorieTarget?: number;
  dayType?: 'normal' | 'rest' | 'training';
  skip?: boolean;
  cookTimeBudgetMinutes?: number;
  useUpBy?: boolean;
  lockedSlots?: { mealType: MealType; recipeId: string }[];
};

/** Narrow a Prisma JSON column to the day-overrides shape (null when absent). */
export function parseDayOverrides(raw: unknown): DayOverridesJson | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as DayOverridesJson;
  }
  return null;
}

/** The date of a day, as the API writes dates. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** As much of a planned meal as says what it amounts to. */
export interface MealAmount {
  servings: number;
  quantityScale: number;
  source: string;
  customMacros: unknown;
  recipe: { caloriesPerServing: number; proteinPerServing: number; fatPerServing: number; carbsPerServing: number } | null;
}

interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/**
 * What a planned meal amounts to: one serving of its recipe, or the macros
 * somebody typed for a meal of their own, times its servings and the factor
 * a rebalance left on it.
 */
export function mealNutrition(meal: MealAmount): Amounts {
  const factor = meal.servings * meal.quantityScale;
  const per =
    meal.source === 'USER_CUSTOM' || !meal.recipe
      ? customMacros(meal.customMacros)
      : { calories: meal.recipe.caloriesPerServing, protein: meal.recipe.proteinPerServing, fat: meal.recipe.fatPerServing, carbs: meal.recipe.carbsPerServing };
  return {
    calories: Math.round(per.calories * factor),
    protein: Math.round(per.protein * factor),
    fat: Math.round(per.fat * factor),
    carbs: Math.round(per.carbs * factor),
  };
}

export function sumNutrition(items: Amounts[]): Amounts {
  return items.reduce((acc, n) => ({ calories: acc.calories + n.calories, protein: acc.protein + n.protein, fat: acc.fat + n.fat, carbs: acc.carbs + n.carbs }), {
    calories: 0,
    protein: 0,
    fat: 0,
    carbs: 0,
  });
}

/** A day the user skips has no meals: that is no day of eating, and no shortfall. */
export function isSkipped(day: { overrides: unknown; meals: unknown[] }): boolean {
  return parseDayOverrides(day.overrides)?.skip === true && day.meals.length === 0;
}

/** What a day of a plan holds on average, over the days that are not skipped. */
export function averageDay(days: { overrides: unknown; meals: MealAmount[] }[]): Amounts {
  const eaten = days.filter((day) => !isSkipped(day));
  if (eaten.length === 0) return { calories: 0, protein: 0, fat: 0, carbs: 0 };
  const total = sumNutrition(eaten.map((day) => sumNutrition(day.meals.map(mealNutrition))));
  return {
    calories: Math.round(total.calories / eaten.length),
    protein: Math.round(total.protein / eaten.length),
    fat: Math.round(total.fat / eaten.length),
    carbs: Math.round(total.carbs / eaten.length),
  };
}

/** Read frozen, user-entered macros off a custom meal row (defaults to zero). */
export function customMacros(raw: unknown): { calories: number; protein: number; fat: number; carbs: number } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    calories: num(o.calories),
    protein: num(o.protein),
    fat: num(o.fat),
    carbs: num(o.carbs),
  };
}
