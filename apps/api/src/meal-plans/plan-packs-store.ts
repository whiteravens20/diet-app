// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { PlanOptions, type Locale, type PlanPacks } from '@diet-app/shared';
import { kitchenFreezes } from '../engine/waste-levels.js';
import { freezerOf, oneFreezer } from './generation-report.js';
import { isoDate } from './plan-days.js';
import {
  onDaysOf,
  packedMealsOf,
  packedLinesIn,
  planPacks,
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
 * days of the plan in order, each with the meals to count; the foods are named
 * in `locale`.
 */
export async function packedOfDays(
  db: Db,
  days: readonly { date: Date; meals: readonly MealRow[] }[],
  mealPrepFriendly: boolean,
  locale: Locale = 'en',
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
          select: { id: true, servings: true, ingredients: packedLinesIn(locale) },
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
  locale: Locale = 'en',
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
    await packedOfDays(db, other.days, PlanOptions.parse(other.options).mealPrepFriendly, locale),
    other.days.map((day) => isoDate(day.date)),
    plan.days.map((day) => isoDate(day.date)),
  );
}

/**
 * What a plan's menu comes to in packs, as reading the plan says it (`planPacks`): the other plan of its kitchen
 * counted with it, freezing where either plan does, and what the freezer held when each was made taken first. Null
 * for a plan the user does not have.
 */
export async function packsOfPlan(
  db: Db,
  userId: string,
  planId: string,
  locale: Locale,
): Promise<PlanPacks | null> {
  const plan = await db.mealPlan.findFirst({
    where: { id: planId, profile: { userId } },
    select: {
      id: true,
      options: true,
      report: true,
      jointPlanId: true,
      days: { orderBy: { date: 'asc' }, select: { date: true, meals: { select: MEAL_ROW } } },
    },
  });
  if (!plan) return null;
  const options = PlanOptions.parse(plan.options);
  const [own, theirs, other] = await Promise.all([
    packedOfDays(db, plan.days, options.mealPrepFriendly, locale),
    partnerPacked(db, userId, plan, locale),
    plan.jointPlanId
      ? db.mealPlan.findFirst({
          where: { jointPlanId: plan.jointPlanId, id: { not: plan.id }, profile: { userId } },
          select: { report: true, options: true },
        })
      : null,
  ]);
  return planPacks(
    [...own, ...theirs],
    plan.days.map((day) => isoDate(day.date)),
    locale,
    // One kitchen freezes where either plan of it does.
    kitchenFreezes(options, ...(other ? [PlanOptions.parse(other.options)] : [])),
    oneFreezer(freezerOf(plan.report), other ? freezerOf(other.report) : null),
  );
}
