// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, MealType, PlanFrozenRest } from '@diet-app/shared';

/** What a meal takes out of the freezer, as a day of the plan says it. */
export interface ThawLine {
  ingredientId: string;
  name: string;
  unit: PlanFrozenRest['unit'];
  amount: number;
  /** The meal's day. */
  date: string;
  /** The meal's time of day; null for a meal of the other plan of the kitchen. */
  mealType: MealType | null;
}

/**
 * What each day of a plan says to take out of the freezer, a whole portion each (`PlanPacks.frozen` and
 * `fromFreezer`): the day before the meal that takes it, where that is a day of the plan from today on
 * (`forTomorrow`), and the meal's own day otherwise (`forToday`). The server says what is taken and when; this says
 * on which card.
 */
export function thawsByDay(
  plan: MealPlan,
  today: string,
): Map<string, { forTomorrow: ThawLine[]; forToday: ThawLine[] }> {
  const dates = plan.days.map((day) => day.date);
  const typeOf = new Map(
    plan.days.flatMap((day) => day.meals.map((meal) => [meal.id, meal.mealType] as const)),
  );
  const said = new Map<string, { forTomorrow: ThawLine[]; forToday: ThawLine[] }>();
  const on = (date: string) => {
    const lines = said.get(date) ?? { forTomorrow: [], forToday: [] };
    said.set(date, lines);
    return lines;
  };
  // A portion of what the freezer held comes out whole; a rest frozen in the plan comes out a portion at a time.
  const portions = [
    ...plan.packs.fromFreezer.map((held) => ({ ...held, thawed: [held] })),
    ...plan.packs.frozen,
  ];
  for (const held of portions) {
    for (const taken of held.thawed) {
      const at = dates.indexOf(taken.date);
      if (at < 0) continue;
      const line: ThawLine = {
        ingredientId: held.ingredientId,
        name: held.name,
        unit: held.unit,
        amount: taken.amount,
        date: taken.date,
        mealType: taken.mealId ? (typeOf.get(taken.mealId) ?? null) : null,
      };
      const before = at > 0 ? dates[at - 1]! : null;
      if (before !== null && before >= today) on(before).forTomorrow.push(line);
      else on(taken.date).forToday.push(line);
    }
  }
  return said;
}

/** Of the rests a plan freezes, those said with a meal of a day, and those said with the day: a meal of another plan. */
export function frozenOfDay(
  plan: MealPlan,
  day: MealPlan['days'][number],
): { byMeal: Map<string, PlanFrozenRest[]>; ofDay: PlanFrozenRest[] } {
  const meals = new Set(day.meals.map((meal) => meal.id));
  const byMeal = new Map<string, PlanFrozenRest[]>();
  const ofDay: PlanFrozenRest[] = [];
  for (const rest of plan.packs.frozen) {
    if (rest.date !== day.date) continue;
    if (rest.mealId && meals.has(rest.mealId))
      byMeal.set(rest.mealId, [...(byMeal.get(rest.mealId) ?? []), rest]);
    else ofDay.push(rest);
  }
  return { byMeal, ofDay };
}
