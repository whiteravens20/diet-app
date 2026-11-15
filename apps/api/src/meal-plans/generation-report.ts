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

const About = { date: z.string().date(), slot: MealType, recipeId: z.string() };

export const StoredReport = z.object({
  relaxations: z.array(z.object({ ...About, gaveWay: z.array(PlanRelaxation).min(1) })),
  singleCandidate: z.array(z.object(About)),
  pantry: PantryUse,
  /** Of a joint plan, the times of day planned apart (`GenerationReport.apart`); none on a report kept before. */
  apart: z.array(MealType).default([]),
  /**
   * What the pantry held in the freezer when the plan was made, of each ingredient, in its canonical unit: what
   * the plan's meals from `from` on take first (`planPacks`). Null where it held nothing, and on a report kept before.
   */
  freezer: z
    .object({
      from: z.string().date(),
      stock: z.array(z.object({ ingredientId: z.string(), amount: z.number().positive() })),
    })
    .nullable()
    .default(null),
});
export type StoredReport = z.infer<typeof StoredReport>;

/** What the pantry held in the freezer when the plan was made (`StoredReport.freezer`), as `planPacks` takes it. */
export interface Freezer {
  from: string;
  stock: ReadonlyMap<string, number>;
}

/** The freezer a kept report holds, or null. */
export function freezerOf(kept: unknown): Freezer | null {
  const freezer = StoredReport.nullable().parse(kept ?? null)?.freezer;
  return freezer
    ? {
        from: freezer.from,
        stock: new Map(freezer.stock.map((held) => [held.ingredientId, held.amount])),
      }
    : null;
}

/** The freezers of the two plans of one kitchen as one: what both held, from the later of their days on. */
export function oneFreezer(a: Freezer | null, b: Freezer | null): Freezer | null {
  if (!a || !b) return a ?? b;
  const stock = new Map(a.stock);
  for (const [ingredientId, amount] of b.stock)
    stock.set(ingredientId, (stock.get(ingredientId) ?? 0) + amount);
  return { from: a.from > b.from ? a.from : b.from, stock };
}

/** What the pantry holds in the freezer, as a report keeps it: from `from` on, or null for nothing. */
export function keptFreezer(
  stock: ReadonlyMap<string, number>,
  from: string,
): StoredReport['freezer'] {
  const held = [...stock]
    .filter(([, amount]) => amount > 0)
    .map(([ingredientId, amount]) => ({ ingredientId, amount }));
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
    pantry,
    apart: [],
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
    pantry: kept.pantry,
    apart: kept.apart,
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
    pantry: report.pantry,
    apart: report.apart,
  };
}
