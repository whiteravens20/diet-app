// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { PlanOptions } from '@diet-app/shared';
import type { Prisma } from '@prisma/client';
import { isoDate } from './plan-days.js';
import { cookingsOf } from './plan-menu.js';

/** A meal of a plan as the pots of its cookings are read from it. */
export interface PotMeal {
  id: string;
  mealType: string;
  recipeId: string | null;
  source: string;
  eatenAt: Date | null;
  servings: number;
  quantityScale: number;
  cookedServings: number | null;
  leftoverFromDate: Date | null;
  leftoverFromMealType: string | null;
  /** The leftover of the pot's rest it gave, where it gave one: a meal of the day after it. */
  givenLeftover: { servings: number; quantityScale: number } | null;
}

/** What a pot cooked already holds for a meal eaten from it. */
export interface Pot {
  /** The day the pot was cooked: the day of the first meal of its cooking. */
  cookedOn: string;
  /** Its servings as eaten when the pot was cooked: what the pot holds for it. */
  cooked: number;
  /** What of that went to the day after as a leftover, in servings as eaten. */
  carried: number;
  /** Whether what was cooked for it is kept on the meal already (`PlannedMeal.cookedServings`), or is still its portion. */
  kept: boolean;
  /** Whether it was eaten: it holds what it was eaten with, and the pot still holds for it what was cooked. */
  eaten: boolean;
}

/**
 * The meals of a plan made for cooking ahead that are eaten from a pot cooked already, and what the pot holds for
 * each: every meal of a cooking after its first, once that first meal is eaten or its day has passed (`today`, the
 * client's day). A leftover standing where it was left counts as its meal eaten.
 */
export function potsOf(
  days: readonly { date: Date; meals: readonly PotMeal[] }[],
  today: string,
): Map<string, Pot> {
  const pots = new Map<string, Pot>();
  const { cookings } = cookingsOf(
    days.map((day) => ({
      date: day.date,
      meals: day.meals.map((meal) => ({
        ...meal,
        recipeId: meal.source === 'USER_CUSTOM' ? null : meal.recipeId,
      })),
    })),
  );
  for (const [first, ...later] of cookings) {
    if (!first) continue;
    const cookedOn = isoDate(days[first.day]!.date);
    if (!first.stand && first.meal.eatenAt === null && cookedOn >= today) continue;
    for (const { meal, stand } of later) {
      if (stand) continue;
      pots.set(meal.id, {
        cookedOn,
        cooked: meal.cookedServings ?? meal.servings * meal.quantityScale,
        carried: meal.givenLeftover
          ? meal.givenLeftover.servings * meal.givenLeftover.quantityScale
          : 0,
        kept: meal.cookedServings !== null,
        eaten: meal.eatenAt !== null,
      });
    }
  }
  return pots;
}

/** What `potsOf` reads of a meal. */
const POT_MEAL = {
  id: true,
  mealType: true,
  recipeId: true,
  source: true,
  eatenAt: true,
  servings: true,
  quantityScale: true,
  cookedServings: true,
  leftoverFromDate: true,
  leftoverFromMealType: true,
  givenLeftover: { select: { servings: true, quantityScale: true } },
} as const;

/** The pots of a plan (`potsOf`), read from the database; none for a plan not made for cooking ahead. */
export async function potsOfPlan(
  db: Pick<Prisma.TransactionClient, 'mealPlan'>,
  planId: string,
  today: string,
): Promise<Map<string, Pot>> {
  const made = await db.mealPlan.findUnique({ where: { id: planId }, select: { options: true } });
  if (!made || !PlanOptions.parse(made.options).mealPrepFriendly) return new Map();
  const plan = await db.mealPlan.findUnique({
    where: { id: planId },
    select: {
      days: { orderBy: { date: 'asc' }, select: { date: true, meals: { select: POT_MEAL } } },
    },
  });
  return plan ? potsOf(plan.days, today) : new Map();
}

/**
 * Keep on each of `meals` eaten from a pot cooked already what was cooked for it, where it is not kept yet: its
 * portion now, which no sizing has changed since the pot was cooked. Called by a sizing before it writes portions.
 */
export async function keepPots(
  tx: Pick<Prisma.TransactionClient, 'plannedMeal'>,
  meals: readonly { id: string; servings: number; quantityScale: number }[],
  pots: ReadonlyMap<string, Pot>,
): Promise<void> {
  for (const meal of meals) {
    const pot = pots.get(meal.id);
    if (!pot || pot.kept) continue;
    await tx.plannedMeal.update({
      where: { id: meal.id },
      data: { cookedServings: meal.servings * meal.quantityScale },
    });
  }
}

/**
 * Forget what was cooked for each meal of a plan that is no longer eaten from a pot cooked already: its dish is
 * another, or its cooking's first meal is no longer eaten and its day is still to come. Run as a write of the plan
 * ends.
 */
export async function settlePots(
  tx: Pick<Prisma.TransactionClient, 'mealPlan' | 'plannedMeal'>,
  planId: string,
  today: string,
): Promise<void> {
  const kept = await tx.plannedMeal.findMany({
    where: { day: { planId }, cookedServings: { not: null } },
    select: { id: true },
  });
  if (kept.length === 0) return;
  const pots = await potsOfPlan(tx, planId, today);
  const gone = kept.filter((meal) => !pots.has(meal.id)).map((meal) => meal.id);
  if (gone.length > 0)
    await tx.plannedMeal.updateMany({
      where: { id: { in: gone } },
      data: { cookedServings: null },
    });
}

/**
 * The most a meal eaten from a pot cooked already may come to, as a scale of its serving: what the pot holds for
 * it, less what of it went to the day after.
 */
export const potScale = (pot: Pot, servings: number): number =>
  Math.max(0, pot.cooked - pot.carried) / servings;

/** What of a pot its meal's portion leaves in it, in servings as eaten: none where it takes all that is left. */
export const potRest = (pot: Pot, portion: number): number => {
  const rest = pot.cooked - pot.carried - portion;
  return rest > 1e-6 ? rest : 0;
};
