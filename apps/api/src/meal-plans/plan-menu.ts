// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PlannedMeal } from '@diet-app/shared';

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
