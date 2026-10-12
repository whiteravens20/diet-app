// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Locale, PlanPacks, PlannedMeal, Unit } from '@diet-app/shared';
import { packUse, toCanonical, UnitConversionError, type ConvertibleIngredient } from '../engine/index.js';
import { pickIngredient } from '../recipes/recipes.service.js';

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

/**
 * What a menu comes to in packs that do not keep once they are opened (see
 * `engine/packs.ts`). `meals` are the meals that have a recipe: the lines of
 * the recipe, and how much of the recipe the meal is (`factor`: its servings
 * over the recipe's). A line whose unit cannot be converted is left out, as
 * a shopping list leaves it out.
 */
export function planPacks(meals: readonly { factor: number; lines: readonly PackedLine[] }[], locale: Locale): PlanPacks {
  const needs = new Map<string, number>();
  const packs = new Map<string, number>();
  const known = new Map<string, PackedLine['ingredient']>();
  for (const meal of meals) {
    for (const line of meal.lines) {
      const { packSize, perishable } = line.ingredient;
      if (!perishable || !packSize || packSize <= 0) continue;
      try {
        needs.set(line.ingredientId, (needs.get(line.ingredientId) ?? 0) + toCanonical(line.quantity * meal.factor, line.unit, line.ingredient));
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
        continue;
      }
      packs.set(line.ingredientId, packSize);
      known.set(line.ingredientId, line.ingredient);
    }
  }
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

/**
 * In a plan made for cooking ahead, which meals are cooked for a later one as
 * well, and which are eaten from what was cooked. `days` are the days of the
 * plan in order, each the recipes of its meals in the order they are eaten,
 * null for a meal without a recipe.
 *
 * A dish is cooked once for the day and the day after, and for a second meal
 * of the same day. On the third day running it is cooked anew: what was
 * cooked on the first is not what is eaten on the third.
 */
export function cookAhead(days: readonly (readonly (string | null)[])[]): PlannedMeal['cookAhead'][][] {
  // What was cooked the day before for this day as well.
  let fromTheDayBefore = new Set<string>();
  return days.map((meals, day) => {
    const tomorrow = new Set(days[day + 1] ?? []);
    const cookedToday = new Set<string>();
    const forTomorrow = new Set<string>();
    const marks = meals.map((recipeId, index): PlannedMeal['cookAhead'] => {
      if (recipeId === null) return null;
      if (fromTheDayBefore.has(recipeId) || cookedToday.has(recipeId)) return 'cooked';
      const laterToday = meals.indexOf(recipeId, index + 1) !== -1;
      if (!tomorrow.has(recipeId) && !laterToday) return null;
      cookedToday.add(recipeId);
      if (tomorrow.has(recipeId)) forTomorrow.add(recipeId);
      return 'cook';
    });
    fromTheDayBefore = forTomorrow;
    return marks;
  });
}
