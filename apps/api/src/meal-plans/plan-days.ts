// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What a day of a plan and its meals carry of their own, as it is kept with them and read back. */
import { LabelTotals, Unit, type DietType, type Macros, type MealType } from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { storedSplit } from '../common/stored-split.js';
import {
  dayMacros,
  distanceOnDiet,
  energyShares,
  MACROS_OFF,
  macroSplitOf,
  sharesOf,
} from '../engine/nutrition.js';
import {
  roundLabel,
  scaleLabel,
  storedTotals,
  sumLabels,
  UNKNOWN_LABEL,
} from '../engine/label-totals.js';
import { REBALANCE_TOLERANCE } from '../engine/rebalance.js';

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

/** Of the plans of a profile that hold a day, the one made last: as the calendar and the diary pick it. */
export const MADE_LAST = [{ plan: { createdAt: 'desc' } }, { planId: 'asc' }] as const;

/**
 * The rest of a pack a meal finishes, in a plan that wastes less, as the meal
 * keeps it (`PlannedMeal.rests`): the ingredient, one of its recipe's, the
 * amount of this meal's portion in the ingredient's own unit, and what that
 * holds, as it was when the rest was put in.
 */
export const StoredRest = z.object({
  ingredientId: z.string().uuid(),
  amount: z.number().positive(),
  /** The ingredient's own unit, which the amount is in. */
  unit: Unit,
  figures: z.object({
    calories: z.number().min(0),
    protein: z.number().min(0),
    fat: z.number().min(0),
    carbs: z.number().min(0),
  }),
  label: LabelTotals,
});
export type StoredRest = z.infer<typeof StoredRest>;

/** The rests a meal keeps: none where it keeps none, or none in this shape. */
export function restsOf(stored: unknown): StoredRest[] {
  const parsed = z.array(StoredRest).safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** Rests as a meal's row keeps them: none is no value. */
export const restsAsJson = (
  rests: readonly StoredRest[],
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  rests.length > 0 ? (rests as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;

/**
 * After meals were given another recipe: each keeps the rests of packs whose
 * ingredient its new recipe holds as well, and loses the others. Run in the
 * write that changed the recipes.
 */
export async function keepRestsOfRecipes(
  tx: Pick<Prisma.TransactionClient, 'plannedMeal'>,
  mealIds: readonly string[],
): Promise<void> {
  if (mealIds.length === 0) return;
  const meals = await tx.plannedMeal.findMany({
    where: { id: { in: [...mealIds] }, rests: { not: Prisma.DbNull } },
    select: {
      id: true,
      rests: true,
      recipe: { select: { ingredients: { select: { ingredientId: true } } } },
    },
  });
  for (const meal of meals) {
    const held = new Set(meal.recipe?.ingredients.map((line) => line.ingredientId) ?? []);
    const rests = restsOf(meal.rests);
    const kept = rests.filter((rest) => held.has(rest.ingredientId));
    if (kept.length !== rests.length)
      await tx.plannedMeal.update({ where: { id: meal.id }, data: { rests: restsAsJson(kept) } });
  }
}

/** The rests of a meal of which a share goes elsewhere, or stays: each amount and what it holds in that share, to a tenth. */
export function scaleRests(stored: unknown, share: number): StoredRest[] {
  const tenth = (value: number): number => Math.round(value * share * 10) / 10;
  return restsOf(stored).flatMap((rest) => {
    const amount = tenth(rest.amount);
    return amount > 0
      ? [
          {
            ...rest,
            amount,
            figures: {
              calories: tenth(rest.figures.calories),
              protein: tenth(rest.figures.protein),
              fat: tenth(rest.figures.fat),
              carbs: tenth(rest.figures.carbs),
            },
            label: roundLabel(scaleLabel(rest.label, share)),
          },
        ]
      : [];
  });
}

/** As much of a planned meal as says what it amounts to. */
export interface MealAmount {
  servings: number;
  quantityScale: number;
  /** The rests of packs it finishes (`restsOf`), counted beside its recipe. */
  rests: unknown;
  source: string;
  customMacros: unknown;
  recipe: {
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
  } | null;
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
      : {
          calories: meal.recipe.caloriesPerServing,
          protein: meal.recipe.proteinPerServing,
          fat: meal.recipe.fatPerServing,
          carbs: meal.recipe.carbsPerServing,
        };
  const rests = restsOf(meal.rests);
  const plus = (of: keyof Amounts): number =>
    rests.reduce((sum, rest) => sum + rest.figures[of], 0);
  return {
    calories: Math.round(per.calories * factor + plus('calories')),
    protein: Math.round(per.protein * factor + plus('protein')),
    fat: Math.round(per.fat * factor + plus('fat')),
    carbs: Math.round(per.carbs * factor + plus('carbs')),
  };
}

/** As much of a planned meal as says what it holds of fibre, sugars, salt and saturated fat. */
export interface MealLabelAmount {
  servings: number;
  quantityScale: number;
  /** The rests of packs it finishes (`restsOf`), counted beside its recipe. */
  rests: unknown;
  source: string;
  recipe: { labelPerServing: unknown } | null;
}

/**
 * What a planned meal holds of fibre, sugars, salt and saturated fat: a serving of its recipe
 * times its servings and the factor a rebalance left on it, to a tenth of a gram. Nothing of them
 * is known of a meal of one's own, nor of a recipe they were not worked out for yet.
 */
export function mealLabel(meal: MealLabelAmount): LabelTotals {
  if (meal.source === 'USER_CUSTOM' || !meal.recipe) return UNKNOWN_LABEL;
  const serving = storedTotals(meal.recipe.labelPerServing);
  if (!serving) return UNKNOWN_LABEL;
  const dish = scaleLabel(serving, meal.servings * meal.quantityScale);
  const rests = restsOf(meal.rests);
  return roundLabel(
    rests.length > 0 ? sumLabels([dish, ...rests.map((rest) => rest.label)]) : dish,
  );
}

export function sumNutrition(items: Amounts[]): Amounts {
  return items.reduce(
    (acc, n) => ({
      calories: acc.calories + n.calories,
      protein: acc.protein + n.protein,
      fat: acc.fat + n.fat,
      carbs: acc.carbs + n.carbs,
    }),
    {
      calories: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
    },
  );
}

/**
 * What a day of a plan aims at of protein, fat and carbohydrate, in grams: the
 * protein of the plan's target, whatever the kind of day, and its own
 * calories in carbohydrate and fat (`dayMacros`).
 */
export const aimOfDay = (
  day: { calorieTarget: number; overrides: unknown },
  plan: { dietType: string; macroSplit: unknown; calorieTarget: number },
): Macros =>
  dayMacros(
    {
      target: day.calorieTarget,
      base: plan.calorieTarget,
      ownTarget: parseDayOverrides(day.overrides)?.calorieTarget ?? null,
    },
    plan.dietType as DietType,
    sharesOf(storedSplit(plan.macroSplit)),
  );

/** A day the user skips is no day of eating and no shortfall, whatever was eaten of it before it was skipped. */
export function isSkipped(day: { overrides: unknown }): boolean {
  return parseDayOverrides(day.overrides)?.skip === true;
}

/**
 * How many meals a day is set for: its own number, the plan's, or else as
 * many as it has from the catalogue (two to five), and the profile's for a day
 * that has none. A day made again, and a change of its settings, start from
 * this.
 */
export function dayMealCount(
  day: { overrides: unknown; meals: { source: string }[] },
  planCount: number | null,
  profileCount: number,
): number {
  const own = parseDayOverrides(day.overrides)?.mealCount;
  if (own !== undefined) return own;
  if (planCount !== null) return planCount;
  const fromCatalogue = day.meals.filter((meal) => meal.source === 'CATALOGUE').length;
  return fromCatalogue > 0 ? Math.min(5, Math.max(2, fromCatalogue)) : profileCount;
}

/**
 * Where a day stands against its target: how far over or under it is, and
 * whether that is outside the window a rebalance brings a day back into. A
 * skipped day is neither over nor under.
 */
export function standingOf(
  calories: number,
  target: number,
  skipped: boolean,
): { calorieDelta: number; offTarget: 'over' | 'under' | null } {
  const calorieDelta = skipped ? 0 : calories - target;
  return {
    calorieDelta,
    offTarget:
      Math.abs(calorieDelta) <= REBALANCE_TOLERANCE * target
        ? null
        : calorieDelta > 0
          ? 'over'
          : 'under',
  };
}

/**
 * What a day of a plan holds of protein, fat and carbohydrate is far from what
 * it aims at: `aim`, the grams of a day (`aimOfDay`), or else the plan's split,
 * as the plan's diet measures it (`distanceOnDiet`).
 */
export function macrosOff(
  held: Macros,
  plan: { dietType: string; macroSplit: unknown },
  aim?: Macros,
): boolean {
  const shares = energyShares(held);
  const split =
    (aim && energyShares(aim)) ??
    macroSplitOf(plan.dietType as DietType, sharesOf(storedSplit(plan.macroSplit)));
  return shares !== null && distanceOnDiet(shares, split, plan.dietType) > MACROS_OFF;
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
export function customMacros(raw: unknown): {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
} {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    calories: num(o.calories),
    protein: num(o.protein),
    fat: num(o.fat),
    carbs: num(o.carbs),
  };
}
