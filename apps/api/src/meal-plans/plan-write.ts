// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { packagesSaid, repickFreezer } from './freezer-repick.js';
import { followRests, wasteLevelOf, type FollowedRest } from './rests-follow.js';

/** At most how many times the sizings a change made are made again: once is nearly always enough. */
const SETTLE_ROUNDS = 3;

type MacroQuad = { calories: number; protein: number; fat: number; carbs: number };

/** What a sizing of days tells whoever made the change (`RebalanceSummary`), as far as making it again changes it. */
interface SizingSummary {
  feasibility: 'in-window' | 'best-effort';
  changes: { mealId: string; before: number; after: number }[];
  macrosAfter: MacroQuad;
  unabsorbedKcal?: number;
}

/** A sizing of days a write made (`noteSizing`). */
interface Sizing {
  /** The plan whose days it sized. */
  planId: string;
  /** The summary that tells of it: its own, or that of the change it went into (`joinSizings`). */
  summary: SizingSummary;
  /** The days whose portions stand as it left them: a later sizing of a day in the same write takes the day over. */
  days: Set<string>;
  /** Its own figures, as it last came to them, in the summary's: none once the summary is another sizing's. */
  figures: MacroQuad | null;
  /** Make it again, as it was made, with nothing noted. */
  again: () => Promise<SizingSummary | null>;
}

/** The sizings of each write, by the transaction it writes in. */
const sizingsOf = new WeakMap<Prisma.TransactionClient, Sizing[]>();

/**
 * Note a sizing of `days` that a write made with `again` (`MealPlansService`). Where the rests of packs that follow
 * the write move on one of the days, the sizing is made again, and what that changes goes into `summary`: an undo of
 * the change puts back every portion it moved. A write that sizes nothing, such as an undo, sizes nothing again.
 */
export function noteSizing(
  tx: Prisma.TransactionClient,
  summary: SizingSummary,
  days: readonly string[],
  again: () => Promise<SizingSummary | null>,
  planId: string,
): void {
  const sizings = sizingsOf.get(tx) ?? [];
  for (const earlier of sizings) for (const day of days) earlier.days.delete(day);
  sizings.push({ planId, summary, days: new Set(days), figures: summary.macrosAfter, again });
  sizingsOf.set(tx, sizings);
}

/**
 * One summary of the sizings of several days a change made: `into`, which keeps its figures, with the meals the
 * others gave another portion. What making them again changes goes into it as well.
 */
export function joinSizings<S extends SizingSummary>(
  tx: Prisma.TransactionClient,
  into: S,
  others: readonly (SizingSummary | null)[],
): S {
  for (const other of others) {
    if (!other || other === into) continue;
    into.changes.push(...other.changes);
    for (const sizing of sizingsOf.get(tx) ?? [])
      if (sizing.summary === other) {
        sizing.summary = into;
        sizing.figures = null;
      }
  }
  return into;
}

/** What making a sizing again changed, in the summary that tells of it: each meal from its portion before the write. */
function absorb(sizing: Sizing, again: SizingSummary): void {
  const { summary } = sizing;
  for (const change of again.changes) {
    const at = summary.changes.findIndex((one) => one.mealId === change.mealId);
    if (at < 0) summary.changes.push(change);
    else if (Math.abs(summary.changes[at]!.before - change.after) < 1e-9)
      summary.changes.splice(at, 1);
    else summary.changes[at] = { ...summary.changes[at]!, after: change.after };
  }
  const was = sizing.figures;
  if (!was) return;
  const now = again.macrosAfter;
  summary.macrosAfter = {
    calories: summary.macrosAfter.calories + now.calories - was.calories,
    protein: summary.macrosAfter.protein + now.protein - was.protein,
    fat: summary.macrosAfter.fat + now.fat - was.fat,
    carbs: summary.macrosAfter.carbs + now.carbs - was.carbs,
  };
  summary.feasibility = again.feasibility;
  if (again.unabsorbedKcal !== undefined) summary.unabsorbedKcal = again.unabsorbedKcal;
  sizing.figures = now;
}

/** A refusal of a change of a plan made from a plan another change moved on meanwhile (`writePlan`). */
export function planChangedMeanwhile(err: ConflictException): boolean {
  const answer = err.getResponse();
  return typeof answer === 'object' && (answer as { error?: unknown }).error === 'PLAN_CHANGED';
}

/**
 * Write a change that was computed from the plan as it stood at
 * `readAtRevision`, and return what `write` returns.
 *
 * The revision is advanced first, and only if it is still the one that was
 * read: when another request changed the plan in the meantime nothing is
 * written and the caller gets `PLAN_CHANGED`. Everything `write` does through
 * `tx` commits or rolls back together with that claim. Two requests that
 * overlap therefore cannot both change the plan, and no lock is held while a
 * change is being computed.
 */
export function writePlan<T>(
  prisma: PrismaClient,
  planId: string,
  readAtRevision: number,
  /** The day it is for whoever asked (`X-Client-Date`, else the server's): what is a day gone is by it. */
  today: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return writePlans(prisma, [{ planId, revision: readAtRevision }], today, write);
}

/**
 * Write a change of several plans together, each computed from the plan as it
 * stood at the revision given with it, as `writePlan` writes one: the change of
 * a meal both plans of a joint plan share is written in both or in neither.
 * The revisions are claimed in one order, so that two such changes of the same
 * plans wait for each other.
 */
export function writePlans<T>(
  prisma: PrismaClient,
  plans: readonly { planId: string; revision: number }[],
  /** The day it is for whoever asked, as `writePlan` takes it. */
  today: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    /** The plans claimed that count their packs (a plan that wastes less or nothing), with the kitchen each is of. */
    const counting: { planId: string; kitchen: string }[] = [];
    for (const { planId, revision } of [...plans].sort((a, b) =>
      a.planId.localeCompare(b.planId),
    )) {
      const claimed = await tx.$queryRaw<{ options: unknown; jointPlanId: string | null }[]>`
        UPDATE "MealPlan" SET "revision" = "revision" + 1
        WHERE "id" = ${planId} AND "revision" = ${revision}
        RETURNING "options", "jointPlanId"`;
      if (claimed.length !== 1) {
        throw new ConflictException({
          error: 'PLAN_CHANGED',
          message: 'The plan changed while this request was running. Reload it and try again.',
        });
      }
      if (wasteLevelOf(claimed[0]!.options))
        counting.push({ planId, kitchen: claimed[0]!.jointPlanId ?? planId });
    }
    // What the plans of each kitchen say to take out of the freezer by today, read before the change: kept after it.
    const said = new Set<string>();
    for (const { planId } of plans)
      for (const key of await packagesSaid(tx, planId, today)) said.add(key);
    const written = await write(tx);
    for (const { planId } of plans) await unlinkDiverged(tx, planId);
    // The rests of packs follow what the change did to the meals, once for each kitchen. A plan of the kitchen whose
    // rests change and that this change did not claim moves on as well: a client that holds it reads it again.
    const claimed = new Set(plans.map((plan) => plan.planId));
    const moveOn = async (followed: readonly FollowedRest[]): Promise<void> => {
      for (const other of new Set(followed.map((one) => one.planId)))
        if (!claimed.has(other)) {
          await tx.mealPlan.update({ where: { id: other }, data: { revision: { increment: 1 } } });
          claimed.add(other);
        }
    };
    const sizings = sizingsOf.get(tx) ?? [];
    const kitchens = new Set<string>();
    for (const { planId, kitchen } of counting) {
      if (kitchens.has(kitchen)) continue;
      kitchens.add(kitchen);
      let followed = await followRests(tx, planId, today);
      await moveOn(followed);
      // A rest that moved changes what its day holds: a sizing of the day this write made is made again with it, and
      // the rests follow the portions that gives, until they stand. A change leaves each day it sized as the next
      // change of the plan finds it.
      for (let round = 0; followed.length > 0 && round < SETTLE_ROUNDS; round += 1) {
        const meals = await tx.plannedMeal.findMany({
          where: { id: { in: followed.map((one) => one.mealId) } },
          select: { dayId: true },
        });
        const moved = new Set(meals.map((meal) => meal.dayId));
        let sized = false;
        for (const sizing of [...sizings]) {
          if (![...sizing.days].some((day) => moved.has(day))) continue;
          const again = await sizing.again();
          if (!again) continue;
          absorb(sizing, again);
          if (again.changes.length > 0) sized = true;
        }
        if (!sized) break;
        followed = await followRests(tx, planId, today);
        await moveOn(followed);
      }
    }
    // What the plans of each kitchen take out of the freezer is chosen again with the menu as the change left it
    // (`repickFreezer`); a plan of the kitchen whose choice changes moves on as well.
    const repicked = new Set<string>();
    for (const { planId } of plans) {
      if (repicked.has(planId)) continue;
      const { kitchen, changed } = await repickFreezer(tx, planId, today, said);
      for (const one of kitchen) repicked.add(one);
      for (const other of changed)
        if (!claimed.has(other)) {
          await tx.mealPlan.update({ where: { id: other }, data: { revision: { increment: 1 } } });
          claimed.add(other);
        }
    }
    return written;
  });
}

/**
 * Undo each shared meal of the plan's joint plan whose two meals no longer
 * hold one dish at its day and time of day: a meal given another dish in one
 * plan alone, given a meal of one's own, or taken off its day. What is left of
 * it is a meal of its own plan (the link is set null with the row). Nothing
 * for a plan of one person.
 */
async function unlinkDiverged(tx: Prisma.TransactionClient, planId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "SharedMeal" AS shared
    WHERE shared."jointPlanId" = (SELECT "jointPlanId" FROM "MealPlan" WHERE "id" = ${planId})
      AND NOT EXISTS (
        SELECT 1
        FROM "PlannedMeal" AS meal
        JOIN "MealPlanDay" AS day ON day."id" = meal."dayId"
        WHERE meal."sharedMealId" = shared."id"
          AND meal."recipeId" IS NOT NULL
          AND meal."mealType" = shared."mealType"
          AND day."date" = shared."date"
        GROUP BY meal."sharedMealId"
        HAVING COUNT(*) = 2 AND COUNT(DISTINCT meal."recipeId") = 1
      )`;
}
