// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, PlanRelaxation } from '@diet-app/shared';

/** A re-roll of a plan, or of one of its days. */
export interface Reroll {
  planId: string;
  dayId?: string;
  /** The first and the last day to fill again, for a part of the plan. */
  from?: string;
  to?: string;
  includePast?: boolean;
  replaceEaten?: boolean;
  replaceCustom?: boolean;
  dropIneligibleLocks?: boolean;
  /** Left out: the limits the plan may let give way already. */
  allowRelaxations?: PlanRelaxation[];
}

/** What a re-roll sends: nothing at all when it asks for nothing of its own. */
export function rerollBody(v: Reroll): Record<string, unknown> | undefined {
  const body = {
    ...(v.from ? { from: v.from } : {}),
    ...(v.to ? { to: v.to } : {}),
    ...(v.includePast ? { includePast: true } : {}),
    ...(v.replaceEaten ? { replaceEaten: true } : {}),
    ...(v.replaceCustom ? { replaceCustom: true } : {}),
    ...(v.dropIneligibleLocks ? { dropIneligibleLocks: true } : {}),
    ...(v.allowRelaxations ? { allowRelaxations: v.allowRelaxations } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
}

/** How much of a plan is asked for: all of it, what is left of it from today, the days from one to another, or one day. */
export type RerollScope = 'whole' | 'from_today' | 'range' | 'day';

/** What the user chose in the window a re-roll is asked for in. */
export interface RerollChoice {
  scope: RerollScope;
  /** The first and the last day, for the days from one to another. */
  from: string;
  to: string;
  /** The day, for one day. */
  day: string;
  includePast: boolean;
  replaceEaten: boolean;
  replaceCustom: boolean;
}

type Days = MealPlan['days'];

/** The first and the last day a choice asks for, of the days of a plan. Dates in this form sort as text. */
export function spanOf(
  days: Days,
  choice: Pick<RerollChoice, 'scope' | 'from' | 'to' | 'day'>,
  today: string,
): { first: string; last: string } {
  const first = days[0]?.date ?? '';
  const last = days.at(-1)?.date ?? '';
  if (choice.scope === 'day') return { first: choice.day, last: choice.day };
  if (choice.scope === 'range') return { first: choice.from, last: choice.to };
  if (choice.scope === 'from_today') return { first: today > first ? today : first, last };
  return { first, last };
}

/** Why "from today on" is not on offer for a plan: it has not begun, so that is all of it, or it is over. */
export function fromTodayRefused(days: Days, today: string): 'not_begun' | 'over' | null {
  const first = days[0]?.date ?? '';
  const last = days.at(-1)?.date ?? '';
  if (today <= first) return 'not_begun';
  return today > last ? 'over' : null;
}

/** What a re-roll would do to a plan as it stands. */
export interface RerollOutcome {
  /** The days that get other meals. */
  days: number;
  /** The meals on them that give place to others. */
  replaced: number;
  /** The days of the plan that were not asked for. */
  keptOutside: number;
  /** The days asked for that stay as they are because they have passed. */
  keptPast: number;
  /** The days asked for that the user skips: they stay empty. */
  keptSkipped: number;
  /** The meals that stay because they were eaten, are the user's own, or are locked to the recipe they have. */
  keptEaten: number;
  keptCustom: number;
  keptLocked: number;
}

/**
 * What a choice would do to the plan: the same reading of it the API makes
 * when the request arrives. A day before today stays unless the choice says
 * otherwise; on a day that is filled again a meal of the user's own and a
 * meal marked as eaten stay unless the choice says otherwise, and a meal
 * locked to its recipe gets that recipe again.
 */
export function rerollOutcome(days: Days, choice: RerollChoice, today: string): RerollOutcome {
  const { first, last } = spanOf(days, choice, today);
  const outcome: RerollOutcome = {
    days: 0,
    replaced: 0,
    keptOutside: 0,
    keptPast: 0,
    keptSkipped: 0,
    keptEaten: 0,
    keptCustom: 0,
    keptLocked: 0,
  };
  for (const day of days) {
    if (day.date < first || day.date > last) outcome.keptOutside += 1;
    else if (day.date < today && !choice.includePast) outcome.keptPast += 1;
    else if (day.skipped) outcome.keptSkipped += 1;
    else {
      let replaced = 0;
      for (const meal of day.meals) {
        const locked =
          day.overrides?.lockedSlots?.some(
            (lock) => lock.mealType === meal.mealType && lock.recipeId === meal.recipe?.id,
          ) ?? false;
        if (meal.source === 'USER_CUSTOM' && !choice.replaceCustom) outcome.keptCustom += 1;
        else if (meal.eatenAt !== null && !choice.replaceEaten) outcome.keptEaten += 1;
        else if (locked) outcome.keptLocked += 1;
        else replaced += 1;
      }
      outcome.replaced += replaced;
      // A day whose every meal stays is not changed by being asked for.
      if (replaced > 0 || day.meals.length === 0) outcome.days += 1;
    }
  }
  return outcome;
}

/** Which of the things a re-roll leaves alone the days of a choice hold at all: there is nothing to ask about the others. */
export function whatCouldGo(
  days: Days,
  choice: RerollChoice,
  today: string,
): { past: boolean; eaten: boolean; custom: boolean } {
  const { first, last } = spanOf(days, choice, today);
  const asked = days.filter((day) => day.date >= first && day.date <= last);
  const filled = asked.filter((day) => !day.skipped && (choice.includePast || day.date >= today));
  return {
    past: asked.some((day) => day.date < today),
    eaten: filled.some((day) => day.meals.some((meal) => meal.eatenAt !== null)),
    custom: filled.some((day) => day.meals.some((meal) => meal.source === 'USER_CUSTOM')),
  };
}
