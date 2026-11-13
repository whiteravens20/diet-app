// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  MEAL_SLOTS_BY_COUNT,
  type Locale,
  type PlanPacks,
  type PlannedMeal,
  type Unit,
} from '@diet-app/shared';
import {
  cookAhead,
  keepDaysOf,
  packUse,
  toCanonical,
  UnitConversionError,
  type ConvertibleIngredient,
  type Pack,
} from '../engine/index.js';
import { pickIngredient } from '../recipes/recipes.service.js';
import { isoDate, plateOfMeal, plateShare, restsOf } from './plan-days.js';

/** A line of a planned meal's recipe, as the count of packs reads it. */
export interface PackedLine {
  ingredientId: string;
  quantity: number;
  unit: Unit;
  ingredient: ConvertibleIngredient & {
    name: string;
    translations?: { locale: string; name: string }[];
    packSize: number | null;
    perishable: boolean;
    keepDays: number | null;
    category: string;
    /** What a person's own plate of a shared dish reads a line's part from (`plateShare`). */
    slug?: string | null;
    proteinKind?: string | null;
  };
}

/**
 * A meal that has a recipe: the lines of the recipe, how much of the recipe the meal is (`factor`: its servings over
 * the recipe's), and the day of the plan its ingredients are taken on, by its place among the days: the day the dish
 * is cooked, for a meal eaten from a dish cooked ahead.
 */
export interface PackedMeal {
  day: number;
  factor: number;
  lines: readonly PackedLine[];
}

/**
 * What meals take of every ingredient whose opened pack does not keep, on each of `days` days, with the pack of each
 * and the ingredient itself. A line whose unit cannot be converted is left out, as a shopping list leaves it out.
 */
export function menuNeeds(
  meals: readonly PackedMeal[],
  days: number,
): {
  needs: Map<string, number[]>;
  packs: Map<string, Pack>;
  known: Map<string, PackedLine['ingredient']>;
} {
  const needs = new Map<string, number[]>();
  const packs = new Map<string, Pack>();
  const known = new Map<string, PackedLine['ingredient']>();
  for (const meal of meals) {
    if (meal.day < 0 || meal.day >= days) continue;
    for (const line of meal.lines) {
      const { packSize, perishable } = line.ingredient;
      if (!perishable || !packSize || packSize <= 0) continue;
      let amount: number;
      try {
        amount = toCanonical(line.quantity * meal.factor, line.unit, line.ingredient);
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
        continue;
      }
      let row = needs.get(line.ingredientId);
      if (!row) {
        row = Array.from({ length: days }, () => 0);
        needs.set(line.ingredientId, row);
      }
      row[meal.day]! += amount;
      packs.set(line.ingredientId, { size: packSize, keepDays: keepDaysOf(line.ingredient) });
      known.set(line.ingredientId, line.ingredient);
    }
  }
  return { needs, packs, known };
}

/**
 * What a menu of `days` days comes to in packs that do not keep once they are opened, counted day by day (see
 * `engine/packs.ts`), as a plan says it.
 */
export function planPacks(meals: readonly PackedMeal[], days: number, locale: Locale): PlanPacks {
  const { needs, packs, known } = menuNeeds(meals, days);
  const use = packUse(needs, packs);
  return {
    bought: use.bought,
    used: use.used,
    // What is left is said to the gram, as it is read; under half a gram is the noise of converting units.
    open: use.open
      .filter((pack) => Math.round(pack.left) >= 1)
      .map((pack) => {
        const ingredient = known.get(pack.ingredientId)!;
        return {
          ingredientId: pack.ingredientId,
          name: pickIngredient(locale, ingredient.translations, ingredient.name),
          unit: ingredient.canonicalUnit,
          packSize: pack.packSize,
          packs: pack.packs,
          left: Math.round(pack.left),
          wasted: pack.wasted,
        };
      }),
  };
}

/** A meal of a day as the cooking ahead reads it. */
export interface MenuMeal {
  id: string;
  mealType: string;
  /** Null for a meal without a recipe. */
  recipeId: string | null;
  leftoverFromDate: Date | null;
  leftoverFromMealType: string | null;
}

/**
 * A place a cooking feeds: a meal of the plan, or the place a leftover was
 * left at (`stand`), where the meal it was left of was eaten nothing of and
 * left its day. `meal` is then the leftover.
 */
export interface CookingPlace<M> {
  day: number;
  meal: M;
  stand: boolean;
}

/** The meals of a day in the order they are eaten. */
const EATEN_IN_ORDER: readonly string[] = MEAL_SLOTS_BY_COUNT[5]!;
const rankOf = (mealType: string): number => {
  const rank = EATEN_IN_ORDER.indexOf(mealType);
  return rank === -1 ? EATEN_IN_ORDER.length : rank;
};

/**
 * The cookings of a plan made for cooking ahead, as `cookAhead` finds them in
 * the dishes of its days, and the mark each meal gets. A leftover cooks
 * nothing: it was cooked with the meal it was left of. Where that meal left its
 * day, nothing of it eaten, the leftover stands at its place, done with, so
 * that what was cooked there for a later meal stays cooked. `days` are the
 * days of the plan in order, each with its meals in any order.
 */
export function cookingsOf<M extends MenuMeal>(
  days: readonly { date: Date; meals: readonly M[] }[],
): { marks: Map<string, PlannedMeal['cookAhead']>; cookings: CookingPlace<M>[][] } {
  const dayOf = new Map(days.map((day, index) => [isoDate(day.date), index]));
  const menu = days.map((day) =>
    day.meals.map((meal) => ({
      meal,
      stand: false,
      mealType: meal.mealType,
      recipeId: meal.leftoverFromDate ? null : meal.recipeId,
    })),
  );
  for (const day of days)
    for (const meal of day.meals) {
      if (!meal.leftoverFromDate || !meal.recipeId) continue;
      const at = dayOf.get(isoDate(meal.leftoverFromDate));
      if (at === undefined) continue;
      // A meal of the dish at that place stands for itself: the meal it was left of, eaten in part, among them.
      const place = menu[at]!;
      if (
        place.some(
          (entry) =>
            entry.mealType === meal.leftoverFromMealType && entry.recipeId === meal.recipeId,
        )
      )
        continue;
      place.push({
        meal,
        stand: true,
        mealType: meal.leftoverFromMealType ?? meal.mealType,
        recipeId: meal.recipeId,
      });
    }
  for (const entries of menu) entries.sort((a, b) => rankOf(a.mealType) - rankOf(b.mealType));
  const found = cookAhead(menu.map((entries) => entries.map((entry) => entry.recipeId)));
  const marks = new Map<string, PlannedMeal['cookAhead']>();
  menu.forEach((entries, day) =>
    entries.forEach((entry, index) => {
      if (!entry.stand) marks.set(entry.meal.id, found.marks[day]![index] ?? null);
    }),
  );
  return {
    marks,
    cookings: found.cookings.map((places) =>
      places.map(({ day, meal }) => ({
        day,
        meal: menu[day]![meal]!.meal,
        stand: menu[day]![meal]!.stand,
      })),
    ),
  };
}

/** The lines of a recipe as the count of packs reads them: a select of `RecipeIngredient`. */
export const PACKED_LINES = {
  select: {
    ingredientId: true,
    quantity: true,
    unit: true,
    ingredient: {
      select: {
        name: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        packSize: true,
        perishable: true,
        keepDays: true,
        category: true,
        slug: true,
        proteinKind: true,
      },
    },
  },
} as const;

/** A meal of a plan as the count of its packs reads it. */
export interface CountedMeal extends MenuMeal {
  source: string;
  servings: number;
  quantityScale: number;
  toppingKey: string | null;
  toppingAmount: number | null;
  /** The rests of packs it finishes (`restsOf`): they are taken from those packs with it. */
  rests: unknown;
  /** A person's own plate of a shared dish (`plateOfMeal`): each line taken at its part's share. */
  plate: unknown;
  /** Null for a meal of the user's own. */
  recipe: { servings: number; ingredients: readonly PackedLine[] } | null;
}

/** The food a topping is of, as the count of packs reads it. */
type ToppingFood = PackedLine['ingredient'] & { id: string };

/**
 * What the meals of a plan take of the packs, as every count of a plan reads
 * them: a meal on its day, one eaten from a dish cooked ahead on the day the
 * dish is cooked (in a plan made for cooking ahead), a leftover not at all (it
 * was cooked with the meal it was left of), a topping with its meal, a meal of
 * the user's own not at all. `days` are the days of the plan in order, each
 * with the meals to count.
 */
export function packedMealsOf(
  days: readonly { date: Date; meals: readonly CountedMeal[] }[],
  mealPrepFriendly: boolean,
  toppingFoods: ReadonlyMap<string, ToppingFood>,
): PackedMeal[] {
  const cookedOnDay = new Map<string, number>();
  if (mealPrepFriendly)
    for (const places of cookingsOf(
      days.map((day) => ({
        date: day.date,
        meals: day.meals.map((meal) => ({
          ...meal,
          recipeId: meal.source === 'USER_CUSTOM' || !meal.recipe ? null : meal.recipeId,
        })),
      })),
    ).cookings)
      for (const place of places) cookedOnDay.set(place.meal.id, places[0]!.day);
  const packed: PackedMeal[] = [];
  days.forEach((day, dayIndex) => {
    for (const meal of day.meals) {
      if (meal.source !== 'USER_CUSTOM' && meal.recipe && !meal.leftoverFromDate) {
        const day = cookedOnDay.get(meal.id) ?? dayIndex;
        const plate = plateOfMeal(meal.plate);
        packed.push({
          day,
          factor: (meal.servings * meal.quantityScale) / Math.max(1, meal.recipe.servings),
          // A person's own plate takes each line at its part's share.
          lines: plate
            ? meal.recipe.ingredients.map((line) => ({
                ...line,
                quantity: line.quantity * plateShare(plate, line.ingredient),
              }))
            : meal.recipe.ingredients,
        });
        // A rest is of an ingredient of the recipe: taken from the same pack, on the same day.
        for (const rest of restsOf(meal.rests)) {
          const line = meal.recipe.ingredients.find(
            (one) => one.ingredientId === rest.ingredientId,
          );
          if (line)
            packed.push({
              day,
              factor: 1,
              lines: [
                {
                  ingredientId: rest.ingredientId,
                  quantity: rest.amount,
                  unit: line.ingredient.canonicalUnit,
                  ingredient: line.ingredient,
                },
              ],
            });
        }
      }
      const food = meal.toppingKey !== null ? toppingFoods.get(meal.toppingKey) : undefined;
      if (food && meal.toppingAmount !== null)
        packed.push({
          day: dayIndex,
          factor: 1,
          lines: [
            {
              ingredientId: food.id,
              quantity: meal.toppingAmount,
              unit: food.canonicalUnit,
              ingredient: food,
            },
          ],
        });
    }
  });
  return packed;
}

/**
 * The meals of another plan on the days of this one: the days of the plan made
 * together with it, each moved to the place of its date among this plan's days;
 * a day this plan does not have counts nothing.
 */
export function onDaysOf(
  packed: readonly PackedMeal[],
  theirDates: readonly string[],
  ourDates: readonly string[],
): PackedMeal[] {
  const ours = new Map(ourDates.map((date, index) => [date, index]));
  return packed.flatMap((meal) => {
    const at = ours.get(theirDates[meal.day] ?? '');
    return at === undefined ? [] : [{ ...meal, day: at }];
  });
}
