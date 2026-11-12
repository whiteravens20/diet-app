// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PlannedMeal } from '@diet-app/shared';

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
