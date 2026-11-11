// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  MEAL_SLOTS_BY_COUNT,
  type Locale,
  type PlanPacks,
  type PlannedMeal,
  type Unit,
} from '@diet-app/shared';
import {
  packUse,
  toCanonical,
  UnitConversionError,
  type ConvertibleIngredient,
} from '../engine/index.js';
import { pickIngredient } from '../recipes/recipes.service.js';
import { isoDate } from './plan-days.js';

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
  };
}

/** A meal that has a recipe: the lines of the recipe, and how much of the recipe the meal is (`factor`: its servings over the recipe's). */
export interface PackedMeal {
  factor: number;
  lines: readonly PackedLine[];
}

/**
 * What meals take of every ingredient whose opened pack does not keep, with
 * the pack of each and the ingredient itself. A line whose unit cannot be
 * converted is left out, as a shopping list leaves it out.
 */
export function menuNeeds(meals: readonly PackedMeal[]): {
  needs: Map<string, number>;
  packs: Map<string, number>;
  known: Map<string, PackedLine['ingredient']>;
} {
  const needs = new Map<string, number>();
  const packs = new Map<string, number>();
  const known = new Map<string, PackedLine['ingredient']>();
  for (const meal of meals) {
    for (const line of meal.lines) {
      const { packSize, perishable } = line.ingredient;
      if (!perishable || !packSize || packSize <= 0) continue;
      try {
        needs.set(
          line.ingredientId,
          (needs.get(line.ingredientId) ?? 0) +
            toCanonical(line.quantity * meal.factor, line.unit, line.ingredient),
        );
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
        continue;
      }
      packs.set(line.ingredientId, packSize);
      known.set(line.ingredientId, line.ingredient);
    }
  }
  return { needs, packs, known };
}

/**
 * What a menu comes to in packs that do not keep once they are opened (see
 * `engine/packs.ts`), as a plan says it.
 */
export function planPacks(meals: readonly PackedMeal[], locale: Locale): PlanPacks {
  const { needs, packs, known } = menuNeeds(meals);
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

/** A meal by where it stands in the days of a plan. */
export interface MenuPlace {
  day: number;
  meal: number;
}

/**
 * In a plan made for cooking ahead, which meals are cooked for a later one as
 * well, and which are eaten from what was cooked, and which meals each cooking
 * feeds. `days` are the days of the plan in order, each the recipes of its meals
 * in the order they are eaten, null for a meal without a recipe.
 *
 * A dish is cooked once for the day and the day after, and for a second meal
 * of the same day. On the third day running it is cooked anew: what was
 * cooked on the first is not what is eaten on the third.
 */
export function cookAhead(days: readonly (readonly (string | null)[])[]): {
  marks: PlannedMeal['cookAhead'][][];
  cookings: MenuPlace[][];
} {
  const cookings: MenuPlace[][] = [];
  // What was cooked the day before for this day as well.
  let fromTheDayBefore = new Map<string, MenuPlace[]>();
  const marks = days.map((meals, day) => {
    const tomorrow = new Set(days[day + 1] ?? []);
    const cookedToday = new Map<string, MenuPlace[]>();
    const forTomorrow = new Map<string, MenuPlace[]>();
    const ofTheDay = meals.map((recipeId, index): PlannedMeal['cookAhead'] => {
      if (recipeId === null) return null;
      const cooked = fromTheDayBefore.get(recipeId) ?? cookedToday.get(recipeId);
      if (cooked) {
        cooked.push({ day, meal: index });
        return 'cooked';
      }
      const laterToday = meals.indexOf(recipeId, index + 1) !== -1;
      if (!tomorrow.has(recipeId) && !laterToday) return null;
      const cooking = [{ day, meal: index }];
      cookings.push(cooking);
      cookedToday.set(recipeId, cooking);
      if (tomorrow.has(recipeId)) forTomorrow.set(recipeId, cooking);
      return 'cook';
    });
    fromTheDayBefore = forTomorrow;
    return ofTheDay;
  });
  return { marks, cookings };
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
