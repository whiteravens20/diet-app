// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { PlanOptions } from '@diet-app/shared';
import type { Prisma } from '@prisma/client';
import { canonical } from '../inventory/eaten-pantry.js';
import { plateOfMeal, plateShare, restsOf } from './plan-days.js';
import { cookingsOf } from './plan-menu.js';
import { toppingIngredientsOf } from './toppings-store.js';
import { pieceFactorOf, pieceUsesOf } from './whole-pieces-store.js';

type Tx = Prisma.TransactionClient;

/** What a meal is read with to say what it ate. */
const EATEN_MEAL = {
  id: true,
  mealType: true,
  recipeId: true,
  source: true,
  servings: true,
  quantityScale: true,
  cookedServings: true,
  leftoverFromDate: true,
  leftoverFromMealType: true,
  toppingKey: true,
  toppingAmount: true,
  plate: true,
  rests: true,
  recipe: {
    select: {
      servings: true,
      ingredients: {
        select: {
          ingredientId: true,
          quantity: true,
          unit: true,
          ingredient: {
            select: {
              slug: true,
              name: true,
              category: true,
              proteinKind: true,
              canonicalUnit: true,
              gramsPerPiece: true,
              density: true,
            },
          },
        },
      },
    },
  },
} as const;

type EatenMeal = Prisma.PlannedMealGetPayload<{ select: typeof EATEN_MEAL }>;

/**
 * What the meal `mealId` of the plan `planId` ate, by ingredient in its canonical unit: its recipe's lines at its
 * portion (a person's plate of a shared dish its share, a pot's eggs and tortillas whole), with its topping and the
 * rest of a pack it finishes. The meal that cooks a pot ahead ate the whole pot, the portions of the meals eaten from
 * it with its own; a meal eaten from a pot cooked so, and a leftover, eaten with the meal it was left of, ate nothing
 * of the pantry.
 */
export async function mealEaten(
  db: Tx,
  planId: string,
  mealId: string,
): Promise<Map<string, number>> {
  const plan = await db.mealPlan.findUnique({
    where: { id: planId },
    select: {
      options: true,
      days: { orderBy: { date: 'asc' }, select: { date: true, meals: { select: EATEN_MEAL } } },
    },
  });
  const meal = plan?.days.flatMap((day) => day.meals).find((one) => one.id === mealId);
  if (!plan || !meal || meal.leftoverFromDate) return new Map();
  let meals: EatenMeal[] = [meal];
  if (PlanOptions.safeParse(plan.options).data?.mealPrepFriendly) {
    const cooking = cookingsOf(plan.days).cookings.find((places) =>
      places.some((place) => place.meal.id === mealId),
    );
    if (cooking) {
      // Eaten from a pot cooked with an earlier meal: that meal took its food.
      if (cooking[0]!.meal.id !== mealId) return new Map();
      meals = cooking.filter((place) => !place.stand).map((place) => place.meal);
    }
  }
  const pieces = await pieceUsesOf(
    db,
    meals.map((one) => one.id),
  );
  const toppings = meals.some((one) => one.toppingKey !== null)
    ? await toppingIngredientsOf(db)
    : new Map<string, { id: string; unit: 'g' | 'ml' | 'piece' }>();
  const toppingIngredients = new Map(
    (
      await db.ingredient.findMany({
        where: { id: { in: [...toppings.values()].map((one) => one.id) } },
        select: { id: true, canonicalUnit: true, gramsPerPiece: true, density: true },
      })
    ).map((row) => [row.id, row]),
  );
  const eaten = new Map<string, number>();
  const add = (ingredientId: string, amount: number | null): void => {
    if (amount !== null && amount > 0)
      eaten.set(ingredientId, (eaten.get(ingredientId) ?? 0) + amount);
  };
  for (const one of meals) {
    const topping = one.toppingKey !== null ? toppings.get(one.toppingKey) : undefined;
    const toppingIngredient = topping ? toppingIngredients.get(topping.id) : undefined;
    if (topping && toppingIngredient && one.toppingAmount !== null)
      add(topping.id, canonical(one.toppingAmount, topping.unit, toppingIngredient));
    if (one.source === 'USER_CUSTOM' || !one.recipe || one.leftoverFromDate) continue;
    const plate = plateOfMeal(one.plate);
    // A meal eaten from a pot cooked already is counted as the pot was cooked for it.
    const portion = (one.cookedServings ?? one.servings * one.quantityScale) / one.recipe.servings;
    for (const line of one.recipe.ingredients)
      add(
        line.ingredientId,
        canonical(
          line.quantity *
            portion *
            plateShare(plate, line.ingredient) *
            pieceFactorOf(pieces.get(one.id) ?? [], line.ingredientId),
          line.unit,
          line.ingredient,
        ),
      );
    // The rest of a pack the meal finishes went into it.
    for (const rest of restsOf(one.rests)) add(rest.ingredientId, rest.amount);
  }
  return eaten;
}
