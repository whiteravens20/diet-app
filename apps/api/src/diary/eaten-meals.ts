// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import {
  EstimatedMacro,
  type DiaryPlanMeal,
  type LabelTotals,
  type Locale,
  type MealType,
} from '@diet-app/shared';
import { roundLabel, sumLabels, toStoredLabel, type StoredLabel } from '../engine/label-totals.js';
import { displayAmount } from '../engine/index.js';
import {
  isoDate,
  mealLabel,
  mealNutrition,
  mealRank,
  sumNutrition,
} from '../meal-plans/plan-days.js';
import {
  toppingFiguresOf,
  toppingFoodsOf,
  type ToppingFoods,
} from '../meal-plans/toppings-store.js';
import { pieced, pieceUsesOf } from '../meal-plans/whole-pieces-store.js';
import { pickIngredient, pickTitle } from '../recipes/recipes.service.js';

/** Energy and the three macronutrients, in kcal and grams. */
interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/**
 * A meal marked eaten in one of a profile's plans, with what it comes to as every reader of its day
 * counts it: its servings and the factor a rebalance left on it, its plate, the rests of packs it
 * finishes, its pot's whole eggs and tortillas, and its topping.
 */
export interface EatenMeal {
  id: string;
  planId: string;
  date: string;
  mealType: MealType;
  /** The servings eaten: the meal's servings times its factor. */
  servings: number;
  /** A meal of one's own: its name, and whether its figures were estimated. Null for a meal of a recipe. */
  own: { name: string; estimated: boolean } | null;
  recipe: { id: string; title: string; translations: { locale: string; title: string }[] } | null;
  nutrition: Amounts;
  label: LabelTotals;
  /** What is put on its plate alone: the food, and how much of it, in the food's canonical unit. */
  topping: { amount: number; food: NonNullable<ReturnType<ToppingFoods['get']>> } | null;
  /** A portion of a dish of a joint plan cooked in one pot and split by weight. */
  fromPot: boolean;
}

type Db = Pick<
  Prisma.TransactionClient,
  'plannedMeal' | 'mealPlanDay' | 'ingredient' | '$queryRaw'
>;

/**
 * The meals marked eaten from `from` to `to`, both included, in the plans of a profile: of every plan,
 * of `only` alone, of every plan but `except`, or, with `overlapping`, of every plan on the days more
 * than one plan holds (one statement more, for those days). In the order of their days and times of day.
 * One statement where none was eaten; one more for what their pots take whole, and one for the foods of
 * their toppings where any has one.
 */
export async function eatenMeals(
  db: Db,
  profileId: string,
  from: Date,
  to: Date,
  plans: { only?: string; except?: string; overlapping?: true } = {},
): Promise<EatenMeal[]> {
  const shared = plans.overlapping
    ? (
        await db.mealPlanDay.groupBy({
          by: ['date'],
          where: { date: { gte: from, lte: to }, plan: { profileId } },
          having: { date: { _count: { gt: 1 } } },
        })
      ).map((day) => day.date)
    : null;
  if (shared?.length === 0) return [];
  const rows = await db.plannedMeal.findMany({
    where: {
      eatenAt: { not: null },
      day: {
        date: shared ? { in: shared } : { gte: from, lte: to },
        plan: {
          profileId,
          ...(plans.only !== undefined ? { id: plans.only } : {}),
          ...(plans.except !== undefined ? { id: { not: plans.except } } : {}),
        },
      },
    },
    select: {
      id: true,
      mealType: true,
      servings: true,
      quantityScale: true,
      source: true,
      customName: true,
      customMacros: true,
      estimated: true,
      rests: true,
      plate: true,
      toppingKey: true,
      toppingAmount: true,
      shared: { select: { apart: true } },
      day: { select: { date: true, planId: true } },
      recipe: {
        select: {
          id: true,
          title: true,
          caloriesPerServing: true,
          proteinPerServing: true,
          fatPerServing: true,
          carbsPerServing: true,
          labelPerServing: true,
          translations: { select: { locale: true, title: true } },
        },
      },
    },
  });
  if (rows.length === 0) return [];
  const [pieces, toppingFoods] = await Promise.all([
    pieceUsesOf(
      db,
      rows.map((row) => row.id),
    ),
    rows.some((row) => row.toppingKey !== null)
      ? toppingFoodsOf(db)
      : Promise.resolve(new Map() as ToppingFoods),
  ]);
  return rows
    .map((row): EatenMeal => {
      const meal = pieced(row, pieces);
      // A topping is eaten with its meal.
      const topping = toppingFiguresOf(meal, toppingFoods);
      const own = meal.source === 'USER_CUSTOM' || !meal.recipe;
      return {
        id: meal.id,
        planId: meal.day.planId,
        date: isoDate(meal.day.date),
        mealType: meal.mealType as MealType,
        servings: meal.servings * meal.quantityScale,
        own: own ? { name: meal.customName ?? '', estimated: meal.estimated } : null,
        recipe: own ? null : meal.recipe,
        nutrition: topping
          ? sumNutrition([mealNutrition(meal), topping.nutrition])
          : mealNutrition(meal),
        label: topping ? roundLabel(sumLabels([mealLabel(meal), topping.label])) : mealLabel(meal),
        topping:
          topping && meal.toppingKey !== null && meal.toppingAmount !== null
            ? { amount: meal.toppingAmount, food: toppingFoods.get(meal.toppingKey)! }
            : null,
        fromPot: meal.shared !== null && !meal.shared.apart,
      };
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        mealRank(a.mealType) - mealRank(b.mealType) ||
        a.id.localeCompare(b.id),
    );
}

/** A meal eaten as a day of the diary lists it, in a reader's language. */
export function diaryMealOf(meal: EatenMeal, locale: Locale): DiaryPlanMeal {
  return {
    id: meal.id,
    mealType: meal.mealType,
    name: nameOf(meal, locale),
    recipeId: meal.recipe?.id ?? null,
    eaten: true,
    nutrition: meal.nutrition,
    label: meal.label,
    topping: meal.topping
      ? {
          name: pickIngredient(locale, meal.topping.food.translations, meal.topping.food.name),
          display: displayAmount(
            meal.topping.amount,
            meal.topping.food.canonicalUnit,
            meal.topping.food,
          ),
        }
      : null,
    fromPot: meal.fromPot,
  };
}

/** The name of a meal eaten in a reader's language: its recipe's title, or the name of a meal of one's own. */
function nameOf(meal: EatenMeal, locale: Locale): string {
  return meal.recipe
    ? pickTitle(locale, meal.recipe.translations, meal.recipe.title)
    : (meal.own?.name ?? '');
}

/** What an entry of the diary that keeps a meal eaten holds, beside its profile and its day. */
export type EatenEntry = {
  mealType: string;
  kind: 'recipe' | 'meal';
  recipeId: string | null;
  name: string;
  servings: number;
  estimated: boolean;
  estimatedMacros: string[];
} & Amounts &
  StoredLabel;

/**
 * A meal eaten as an entry of the diary keeps it: a meal of a recipe as an entry of that recipe, a meal
 * of one's own as a meal of one's own, each with the servings eaten and the figures its day counted,
 * named in the language given.
 */
export function entryOfEaten(meal: EatenMeal, locale: Locale): EatenEntry {
  return {
    mealType: meal.mealType,
    kind: meal.recipe ? 'recipe' : 'meal',
    recipeId: meal.recipe?.id ?? null,
    name: nameOf(meal, locale),
    servings: meal.servings,
    // A planned meal of its own keeps whether it was estimated, not which figure: all of them were.
    estimated: meal.own?.estimated ?? false,
    estimatedMacros: meal.own?.estimated ? [...EstimatedMacro.options] : [],
    ...meal.nutrition,
    ...toStoredLabel(meal.label),
  };
}
