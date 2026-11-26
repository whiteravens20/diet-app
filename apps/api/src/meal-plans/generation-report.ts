// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the generation of a plan had to do to fill it: as it is kept with the
 * plan, and as it is shown.
 *
 * What is kept names, for each meal it speaks of, the recipe that was put
 * there. A meal that was changed since holds another recipe, so what was said
 * about it no longer holds and is left out of what is shown. Nothing that
 * changes a meal has to remember the report.
 */
import { z } from 'zod';
import {
  MealType,
  PantryUse,
  PlanRelaxation,
  type GenerationReport,
  type MealPlanDay,
} from '@diet-app/shared';
import type { OptimizerResult } from '../engine/index.js';
import { goingOffFirst } from '../inventory/pantry-store.js';

const About = { date: z.string().date(), slot: MealType, recipeId: z.string() };

export const StoredReport = z.object({
  relaxations: z.array(z.object({ ...About, gaveWay: z.array(PlanRelaxation).min(1) })),
  singleCandidate: z.array(z.object(About)),
  /**
   * Meals of days made again by themselves that got the recipe they held: the plan's limits left them no other
   * (`GenerationReport.sameAgain`). None on a report kept before.
   */
  sameAgain: z.array(z.object(About)).default([]),
  pantry: PantryUse,
  /** Of a joint plan, the times of day planned apart (`GenerationReport.apart`); none on a report kept before. */
  apart: z.array(MealType).default([]),
  /**
   * How many meals the plan's days were made with where a day has none of its own: what a day that lost a meal, or
   * gave one to a meal of the user's own, is still set for (`planMealCount`). Null on a report kept before.
   */
  mealCount: z.number().int().min(2).max(5).nullable().default(null),
  /**
   * The packages of the profile's freezer the plan takes out, each by its ingredient, in its canonical unit, with its
   * number (`InventoryItem.parcel`) and its best-before day: what the plan's meals from `from` on take first
   * (`planPacks`), the one going off first first. Null where it takes nothing, and on a report kept before. A report
   * kept before packages has one entry a food, of no number and no day: the one frozen row of the food then, package 0.
   */
  freezer: z
    .object({
      from: z.string().date(),
      stock: z.array(
        z.object({
          ingredientId: z.string(),
          amount: z.number().positive(),
          parcel: z.number().int().nonnegative().default(0),
          bestBefore: z.string().date().nullable().default(null),
          /**
           * The first day the package may be eaten from, where that is later than `from`: one the plan takes out
           * after a change of it (`repickFreezer`), from the day after the change. Left out for the freezer's day.
           */
          from: z.string().date().optional(),
        }),
      ),
    })
    .nullable()
    .default(null),
});
export type StoredReport = z.infer<typeof StoredReport>;

/**
 * A package of the freezer a plan takes out: what it holds in its food's canonical unit, its number, its day, and the
 * first day it may be eaten from where that is later than the freezer's (`StoredReport.freezer`).
 */
export interface FreezerPackage {
  amount: number;
  parcel: number;
  bestBefore: string | null;
  from?: string;
}

/** What a plan takes out of the freezer (`StoredReport.freezer`), as `planPacks` takes it: the packages of each food. */
export interface Freezer {
  from: string;
  stock: ReadonlyMap<string, readonly FreezerPackage[]>;
}

/** The freezer a kept report holds, or null. */
export function freezerOf(kept: unknown): Freezer | null {
  const freezer = StoredReport.nullable().parse(kept ?? null)?.freezer;
  if (!freezer) return null;
  const stock = new Map<string, FreezerPackage[]>();
  for (const { ingredientId, amount, parcel, bestBefore, from } of freezer.stock)
    stock.set(ingredientId, [
      ...(stock.get(ingredientId) ?? []),
      { amount, parcel, bestBefore, from },
    ]);
  return { from: freezer.from, stock };
}

/**
 * The freezers of the two plans of one kitchen as one: the packages both take out, each food's in the order they are
 * taken out (`goingOffFirst`), from the later of their days on.
 */
export function oneFreezer(a: Freezer | null, b: Freezer | null): Freezer | null {
  if (!a || !b) return a ?? b;
  const stock = new Map<string, FreezerPackage[]>(
    [...a.stock].map(([id, list]) => [id, [...list]]),
  );
  for (const [ingredientId, list] of b.stock)
    stock.set(ingredientId, [...(stock.get(ingredientId) ?? []), ...list].sort(goingOffFirst));
  return { from: a.from > b.from ? a.from : b.from, stock };
}

/** The packages a plan takes out of the freezer, as a report keeps them: from `from` on, or null for none. */
export function keptFreezer(
  stock: ReadonlyMap<string, readonly Pick<FreezerPackage, 'amount' | 'parcel' | 'bestBefore'>[]>,
  from: string,
): StoredReport['freezer'] {
  const held = [...stock].flatMap(([ingredientId, list]) =>
    list
      .filter((one) => one.amount > 0)
      .map(({ amount, parcel, bestBefore }) => ({ ingredientId, amount, parcel, bestBefore })),
  );
  return held.length > 0 ? { from, stock: held } : null;
}

/**
 * The report of a run in the terms of the plan: `dates` are the dates of the
 * days the run was given, in its order.
 */
export function reportOf(
  result: OptimizerResult,
  dates: readonly string[],
  pantry: PantryUse,
  freezer: StoredReport['freezer'] = null,
): StoredReport {
  const about = (at: { dayIndex: number; slot: MealType }) => ({
    date: dates[at.dayIndex]!,
    slot: at.slot,
    recipeId: result.assignments.find(
      (placed) => placed.dayIndex === at.dayIndex && placed.slot === at.slot,
    )!.recipeId,
  });
  return {
    relaxations: result.report.relaxations.map((at) => ({ ...about(at), gaveWay: at.gaveWay })),
    singleCandidate: result.report.singleCandidate.map(about),
    sameAgain: [],
    pantry,
    apart: [],
    mealCount: null,
    freezer,
  };
}

/**
 * The report of a plan after some of its days were filled again: what it said
 * of those days gives place to what the run over them found. What the pantry
 * had to do with the plan, and what its freezer held, stay what they were when
 * the plan was made.
 */
export function withDaysAgain(
  kept: StoredReport,
  fresh: StoredReport,
  dates: readonly string[],
): StoredReport {
  const ofOtherDays = <T extends { date: string }>(entries: T[]): T[] =>
    entries.filter((entry) => !dates.includes(entry.date));
  return {
    relaxations: [...ofOtherDays(kept.relaxations), ...fresh.relaxations],
    singleCandidate: [...ofOtherDays(kept.singleCandidate), ...fresh.singleCandidate],
    sameAgain: [...ofOtherDays(kept.sameAgain), ...fresh.sameAgain],
    pantry: kept.pantry,
    apart: kept.apart,
    mealCount: kept.mealCount,
    freezer: kept.freezer,
  };
}

/**
 * A report that says one more meal is outside limits of its plan: a recipe put
 * on it after the plan was made, by hand or for want of another. What it said
 * of that recipe on that meal before gives way.
 */
export function withMealOutside(
  kept: StoredReport,
  meal: StoredReport['relaxations'][number],
): StoredReport {
  return {
    ...kept,
    relaxations: [
      ...kept.relaxations.filter(
        (entry) =>
          entry.date !== meal.date || entry.slot !== meal.slot || entry.recipeId !== meal.recipeId,
      ),
      meal,
    ],
  };
}

/** What a kept report still says of the plan as it is, in the order of its days and meals. */
export function shownReport(kept: unknown, days: readonly MealPlanDay[]): GenerationReport | null {
  const report = StoredReport.nullable().parse(kept ?? null);
  if (!report) return null;

  const key = (date: string, slot: string, recipeId: string) => `${date} ${slot} ${recipeId}`;
  const place = new Map<string, number>();
  for (const day of days) {
    for (const meal of day.meals) {
      if (meal.recipe) place.set(key(day.date, meal.mealType, meal.recipe.id), place.size);
    }
  }
  const standing = <T extends { date: string; slot: MealType; recipeId: string }>(
    entries: T[],
  ): T[] =>
    entries
      .filter((entry) => place.has(key(entry.date, entry.slot, entry.recipeId)))
      .sort(
        (a, b) =>
          place.get(key(a.date, a.slot, a.recipeId))! - place.get(key(b.date, b.slot, b.recipeId))!,
      );

  return {
    relaxations: standing(report.relaxations).map(({ date, slot, gaveWay }) => ({
      date,
      slot,
      gaveWay,
    })),
    singleCandidate: standing(report.singleCandidate).map(({ date, slot }) => ({ date, slot })),
    sameAgain: standing(report.sameAgain).map(({ date, slot }) => ({ date, slot })),
    pantry: report.pantry,
    apart: report.apart,
  };
}
