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
  potHeld: boolean;
  leftoverFromDate: Date | null;
  leftoverFromMealType: string | null;
  /** The leftover it gave, where it gave one: a meal of the day after it (`leftoversGiven`). */
  givenLeftoverId: string | null;
}

/** A leftover a meal gave: what it holds, in servings as eaten. */
export interface GivenLeftover {
  portion: number;
}

/** A leftover as `leftoversGiven` reads it from its row. */
const givenOf = (meal: { servings: number; quantityScale: number }): GivenLeftover => ({
  portion: meal.servings * meal.quantityScale,
});

/**
 * The leftovers the meals of `days` gave, by their ids. A leftover is a meal of the day after its meal, in the plan
 * of the profile made last that holds that day: most often one of `days`, read as they hold it, and otherwise one of
 * another plan, read where there is any such.
 */
export async function leftoversGiven(
  db: Pick<Prisma.TransactionClient, 'plannedMeal'>,
  days: readonly {
    meals: readonly {
      id: string;
      servings: number;
      quantityScale: number;
      givenLeftoverId: string | null;
    }[];
  }[],
): Promise<Map<string, GivenLeftover>> {
  const meals = days.flatMap((day) => day.meals);
  const given = new Map<string, GivenLeftover>();
  const held = new Map(meals.map((meal) => [meal.id, meal]));
  const elsewhere: string[] = [];
  for (const { givenLeftoverId: id } of meals) {
    if (id === null) continue;
    const meal = held.get(id);
    if (meal) given.set(id, givenOf(meal));
    else elsewhere.push(id);
  }
  if (elsewhere.length > 0)
    for (const meal of await db.plannedMeal.findMany({
      where: { id: { in: elsewhere } },
      select: { id: true, servings: true, quantityScale: true },
    }))
      given.set(meal.id, givenOf(meal));
  return given;
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
  /** Whether its last sizing would have given it more than the pot holds for it (`PlannedMeal.potHeld`). */
  held: boolean;
}

/**
 * The meals of a plan made for cooking ahead that are eaten from a pot cooked already, and what the pot holds for
 * each: every meal of a cooking after its first, once that first meal is eaten or its day has passed (`today`, the
 * client's day). A leftover standing where it was left counts as its meal eaten.
 */
export function potsOf(
  days: readonly { date: Date; meals: readonly PotMeal[] }[],
  today: string,
  /** The leftovers the meals gave (`leftoversGiven`). */
  given: ReadonlyMap<string, GivenLeftover>,
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
        carried: meal.givenLeftoverId ? (given.get(meal.givenLeftoverId)?.portion ?? 0) : 0,
        kept: meal.cookedServings !== null,
        eaten: meal.eatenAt !== null,
        held: meal.potHeld,
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
  potHeld: true,
  leftoverFromDate: true,
  leftoverFromMealType: true,
  givenLeftoverId: true,
} as const;

/** The pots of a plan (`potsOf`), read from the database; none for a plan not made for cooking ahead. */
export async function potsOfPlan(
  db: Pick<Prisma.TransactionClient, 'mealPlan' | 'plannedMeal'>,
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
  return plan ? potsOf(plan.days, today, await leftoversGiven(db, plan.days)) : new Map();
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
      data: { cookedServings: null, potHeld: false },
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

/**
 * What a sizing says of each meal of `rows` eaten from a pot cooked already: held (true) where it left the meal at
 * its cap (`mostScale`) and the same sizing without the caps (`free`) would give it more; not held (false) where it
 * left the meal under its cap, something left in the pot. A meal at its cap that it would give no more is left out,
 * as it was: a sizing that leaves a day as it is, after one that the pot held, says nothing new of it.
 */
export function heldAtPots(
  rows: readonly { id: string; quantityScale: number; mostScale?: number }[],
  scales: ReadonlyMap<string, number>,
  free: () => ReadonlyMap<string, number>,
): Map<string, boolean> {
  const said = new Map<string, boolean>();
  const atCap: { id: string; quantityScale: number; mostScale: number }[] = [];
  for (const row of rows) {
    if (row.mostScale === undefined) continue;
    if ((scales.get(row.id) ?? row.quantityScale) < row.mostScale - 1e-6) said.set(row.id, false);
    else atCap.push({ ...row, mostScale: row.mostScale });
  }
  if (atCap.length === 0) return said;
  const freely = free();
  for (const row of atCap)
    if ((freely.get(row.id) ?? row.quantityScale) > row.mostScale + 1e-6) said.set(row.id, true);
  return said;
}

/** Write on the meals eaten from a pot cooked already what a sizing says of them (`heldAtPots`). */
export async function keepHeld(
  tx: Pick<Prisma.TransactionClient, 'plannedMeal'>,
  said: ReadonlyMap<string, boolean>,
): Promise<void> {
  for (const held of [true, false]) {
    const ids = [...said].filter(([, is]) => is === held).map(([id]) => id);
    if (ids.length > 0)
      await tx.plannedMeal.updateMany({
        where: { id: { in: ids }, potHeld: !held },
        data: { potHeld: held },
      });
  }
}
