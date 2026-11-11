// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the toppings of a joint plan are read from: the foods of the list this
 * instance has, and the traits of the dishes they would go beside.
 */
import type { Prisma } from '@prisma/client';
import type { LabelTotals, Unit } from '@diet-app/shared';
import { proposeTraits, traitsOf } from '../engine/dish-traits.js';
import { labelOfAmount } from '../engine/label-totals.js';
import { proteinKindsOf } from '../engine/optimizer.js';
import { fullKindsOn } from '../engine/topped-days.js';
import {
  holdsAMeatStandIn,
  TOPPINGS,
  type ToppingDish,
  type ToppingEater,
  type ToppingOption,
} from '../engine/toppings.js';
import { mealsPerKind } from './plan-limits.js';

/** The toppings whose foods this instance has, in the order of the list, with what 100 of each holds. */
export async function toppingOptionsOf(
  db: Pick<Prisma.TransactionClient, 'ingredient'>,
): Promise<ToppingOption[]> {
  const foods = await db.ingredient.findMany({
    where: { slug: { in: TOPPINGS.map((topping) => topping.slug) } },
    select: {
      id: true,
      slug: true,
      allergens: true,
      dietCompatibility: true,
      proteinKind: true,
      caloriesPer100: true,
      proteinPer100: true,
      fatPer100: true,
      carbsPer100: true,
    },
  });
  const bySlug = new Map(foods.map((food) => [food.slug, food]));
  return TOPPINGS.flatMap((topping) => {
    const food = bySlug.get(topping.slug);
    if (!food) return [];
    return [
      {
        topping,
        food: {
          id: food.id,
          allergens: food.allergens,
          dietCompatibility: food.dietCompatibility,
          proteinKind: food.proteinKind,
        },
        per100: {
          calories: food.caloriesPer100,
          protein: food.proteinPer100,
          fat: food.fatPer100,
          carbs: food.carbsPer100,
        },
      },
    ];
  });
}

/**
 * The recipes asked for as the check of a topping reads them: the traits set
 * on each, the rest as its ingredients and titles suggest, and whether it is
 * built on a stand-in for meat.
 */
export async function dishTraitsOf(
  db: Pick<Prisma.TransactionClient, 'recipe'>,
  recipeIds: readonly string[],
): Promise<Map<string, ToppingDish>> {
  if (recipeIds.length === 0) return new Map();
  const recipes = await db.recipe.findMany({
    where: { id: { in: [...new Set(recipeIds)] } },
    select: {
      id: true,
      title: true,
      taste: true,
      form: true,
      starchBase: true,
      translations: { select: { title: true } },
      ingredients: {
        select: {
          quantity: true,
          unit: true,
          ingredient: {
            select: {
              slug: true,
              name: true,
              category: true,
              caloriesPer100: true,
              canonicalUnit: true,
              gramsPerPiece: true,
              density: true,
            },
          },
        },
      },
    },
  });
  return new Map(
    recipes.map((recipe) => [
      recipe.id,
      {
        ...traitsOf(recipe, () =>
          proposeTraits(
            [recipe.title, ...recipe.translations.map((translation) => translation.title)],
            recipe.ingredients.map((line) => ({
              quantity: line.quantity,
              unit: line.unit as Unit,
              ingredient: {
                ...line.ingredient,
                canonicalUnit: line.ingredient.canonicalUnit as Unit,
              },
            })),
          ),
        ),
        meatStandIn: holdsAMeatStandIn(recipe.ingredients.map((line) => line.ingredient.slug)),
      },
    ]),
  );
}

/** A profile as the check of a topping reads it, the kinds of protein it has no more meals of given. */
export function eaterOf(
  diet: string,
  preferences: {
    allergens: string[];
    excludedIngredientIds: string[];
    dislikedIngredientIds: string[];
  } | null,
  fullKinds: ReadonlySet<string>,
  respectExclusions = true,
): ToppingEater {
  return {
    diet,
    allergens: preferences?.allergens ?? [],
    excluded: new Set(respectExclusions ? (preferences?.excludedIngredientIds ?? []) : []),
    disliked: new Set(preferences?.dislikedIngredientIds ?? []),
    fullKinds,
  };
}

/** A topping's food as a plan's answer reads it: named, measured and counted. */
export async function toppingFoodsOf(db: Pick<Prisma.TransactionClient, 'ingredient'>) {
  const foods = await db.ingredient.findMany({
    where: { slug: { in: TOPPINGS.map((topping) => topping.slug) } },
    select: {
      id: true,
      slug: true,
      name: true,
      canonicalUnit: true,
      gramsPerPiece: true,
      density: true,
      displayUnit: true,
      perTeaspoon: true,
      caloriesPer100: true,
      proteinPer100: true,
      fatPer100: true,
      carbsPer100: true,
      fiberPer100: true,
      sugarsPer100: true,
      saltPer100: true,
      saturatedFatPer100: true,
      packSize: true,
      perishable: true,
      translations: { select: { locale: true, name: true } },
    },
  });
  const bySlug = new Map(foods.map((food) => [food.slug, food]));
  return new Map(
    TOPPINGS.flatMap((topping) => {
      const food = bySlug.get(topping.slug);
      return food ? [[topping.key, food] as const] : [];
    }),
  );
}

export type ToppingFoods = Awaited<ReturnType<typeof toppingFoodsOf>>;

const DAY_MS = 86_400_000;

/**
 * What the toppings of a day of a joint plan are decided from: the foods of
 * the list, the traits of the dishes at its places, the person, held to the
 * kinds of protein the day, and the seven days it is one of, have no more
 * meals of, and the toppings the person has on the other days of those weeks.
 */
export async function toppingAskOfDay(
  db: Pick<Prisma.TransactionClient, 'ingredient' | 'recipe' | 'profile' | 'plannedMeal'>,
  plan: { id: string; profileId: string; dietType: string },
  date: Date,
  placeRecipeIds: readonly string[],
): Promise<{
  options: ToppingOption[];
  traits: Map<string, ToppingDish>;
  eater: ToppingEater;
  used: Map<string, number>;
}> {
  const from = new Date(date.getTime() - 6 * DAY_MS);
  const to = new Date(date.getTime() + 6 * DAY_MS);
  const [options, traits, profile, around] = await Promise.all([
    toppingOptionsOf(db),
    dishTraitsOf(db, placeRecipeIds),
    db.profile.findUnique({
      where: { id: plan.profileId },
      select: {
        preferences: {
          select: {
            allergens: true,
            excludedIngredientIds: true,
            dislikedIngredientIds: true,
            maxMealsPerDaySameKind: true,
            maxMealsPerWeekSameKind: true,
            kindLimits: true,
          },
        },
      },
    }),
    db.plannedMeal.findMany({
      where: { recipeId: { not: null }, day: { planId: plan.id, date: { gte: from, lte: to } } },
      select: {
        recipeId: true,
        toppingKey: true,
        day: { select: { date: true } },
        recipe: {
          select: {
            ingredients: {
              select: {
                quantity: true,
                unit: true,
                ingredient: {
                  select: {
                    canonicalUnit: true,
                    gramsPerPiece: true,
                    density: true,
                    proteinPer100: true,
                    proteinKind: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);
  const kinds = new Map(
    around.flatMap((meal) =>
      meal.recipe
        ? [
            [
              meal.recipeId!,
              proteinKindsOf({
                ingredients: meal.recipe.ingredients.map((line) => ({
                  ...line,
                  unit: line.unit as Unit,
                })),
              }),
            ] as const,
          ]
        : [],
    ),
  );
  const fullKinds = fullKindsOn(
    6,
    around.map((meal) => ({
      dayIndex: Math.round((meal.day.date.getTime() - from.getTime()) / DAY_MS),
      recipeId: meal.recipeId!,
    })),
    (recipeId) => kinds.get(recipeId) ?? [],
    mealsPerKind(profile?.preferences ?? null),
  );
  const used = new Map<string, number>();
  for (const meal of around) {
    if (meal.toppingKey === null || meal.day.date.getTime() === date.getTime()) continue;
    used.set(meal.toppingKey, (used.get(meal.toppingKey) ?? 0) + 1);
  }
  return {
    options,
    traits,
    eater: eaterOf(plan.dietType, profile?.preferences ?? null, fullKinds),
    used,
  };
}

/** What a meal's topping holds, as its food says it: figures rounded as a meal's are, and its label. */
export function toppingFiguresOf(
  meal: { toppingKey: string | null; toppingAmount: number | null },
  foods: ToppingFoods,
): {
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
  label: LabelTotals;
} | null {
  const food = meal.toppingKey !== null ? foods.get(meal.toppingKey) : undefined;
  if (!food || meal.toppingAmount === null) return null;
  const part = meal.toppingAmount / 100;
  return {
    nutrition: {
      calories: Math.round(food.caloriesPer100 * part),
      protein: Math.round(food.proteinPer100 * part),
      fat: Math.round(food.fatPer100 * part),
      carbs: Math.round(food.carbsPer100 * part),
    },
    label: labelOfAmount(food, meal.toppingAmount),
  };
}

/** The ingredient each topping is, and the unit its amount is in. */
export async function toppingIngredientsOf(
  db: Pick<Prisma.TransactionClient, 'ingredient'>,
): Promise<Map<string, { id: string; unit: Unit }>> {
  const foods = await db.ingredient.findMany({
    where: { slug: { in: TOPPINGS.map((topping) => topping.slug) } },
    select: { id: true, slug: true, canonicalUnit: true },
  });
  const bySlug = new Map(foods.map((food) => [food.slug, food]));
  return new Map(
    TOPPINGS.flatMap((topping) => {
      const food = bySlug.get(topping.slug);
      return food
        ? [[topping.key, { id: food.id, unit: food.canonicalUnit as Unit }] as const]
        : [];
    }),
  );
}

/** The kcal of the toppings of the meals given, their foods read only where one has any. */
export async function toppingKcal(
  db: Pick<Prisma.TransactionClient, 'ingredient'>,
  meals: readonly { toppingKey: string | null; toppingAmount: number | null }[],
): Promise<number> {
  if (!meals.some((meal) => meal.toppingKey !== null)) return 0;
  const foods = await toppingFoodsOf(db);
  return meals.reduce(
    (sum, meal) => sum + (toppingFiguresOf(meal, foods)?.nutrition.calories ?? 0),
    0,
  );
}
