// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { PlanOptions } from '@diet-app/shared';
import { isoDate } from './plan-days.js';
import {
  onDaysOf,
  packedMealsOf,
  PACKED_LINES,
  type CountedMeal,
  type PackedMeal,
} from './plan-menu.js';
import { toppingFoodsOf, type ToppingFoods } from './toppings-store.js';

type Db = Pick<Prisma.TransactionClient, 'recipe' | 'ingredient' | 'mealPlan'>;

/** A meal of a plan as it is read for the count of packs, without its recipe's lines. */
type MealRow = Omit<CountedMeal, 'recipe'>;

/** The fields of a planned meal `MealRow` reads: a select of `PlannedMeal`. */
const MEAL_ROW = {
  id: true,
  mealType: true,
  recipeId: true,
  source: true,
  servings: true,
  quantityScale: true,
  leftoverFromDate: true,
  leftoverFromMealType: true,
  toppingKey: true,
  toppingAmount: true,
  rests: true,
  plate: true,
} as const;

/**
 * What the meals of a plan's days take of the packs (`packedMealsOf`), with
 * their recipes' lines and their toppings' foods read here. `days` are all the
 * days of the plan in order, each with the meals to count.
 */
export async function packedOfDays(
  db: Db,
  days: readonly { date: Date; meals: readonly MealRow[] }[],
  mealPrepFriendly: boolean,
): Promise<PackedMeal[]> {
  const meals = days.flatMap((day) => day.meals);
  const recipeIds = [
    ...new Set(
      meals.flatMap((meal) =>
        meal.source !== 'USER_CUSTOM' && meal.recipeId ? [meal.recipeId] : [],
      ),
    ),
  ];
  const [recipes, toppingFoods] = await Promise.all([
    recipeIds.length > 0
      ? db.recipe.findMany({
          where: { id: { in: recipeIds } },
          select: { id: true, servings: true, ingredients: PACKED_LINES },
        })
      : [],
    meals.some((meal) => meal.toppingKey !== null)
      ? toppingFoodsOf(db)
      : (new Map() as ToppingFoods),
  ]);
  const recipeOf = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  return packedMealsOf(
    days.map((day) => ({
      date: day.date,
      meals: day.meals.map((meal) => ({
        ...meal,
        recipe: (meal.recipeId && recipeOf.get(meal.recipeId)) || null,
      })),
    })),
    mealPrepFriendly,
    toppingFoods,
  );
}

/**
 * Of a plan of a joint plan, what the other plan's meals take of the packs, on
 * the days of this one: the two are cooked in one kitchen. Nothing for a plan
 * made alone, or one whose other plan is gone.
 */
export async function partnerPacked(
  db: Db,
  userId: string,
  plan: { id: string; jointPlanId: string | null; days: readonly { date: Date }[] },
): Promise<PackedMeal[]> {
  if (!plan.jointPlanId) return [];
  const other = await db.mealPlan.findFirst({
    where: { jointPlanId: plan.jointPlanId, id: { not: plan.id }, profile: { userId } },
    select: {
      options: true,
      days: {
        orderBy: { date: 'asc' },
        select: { date: true, meals: { select: MEAL_ROW } },
      },
    },
  });
  if (!other) return [];
  return onDaysOf(
    await packedOfDays(db, other.days, PlanOptions.parse(other.options).mealPrepFriendly),
    other.days.map((day) => isoDate(day.date)),
    plan.days.map((day) => isoDate(day.date)),
  );
}
