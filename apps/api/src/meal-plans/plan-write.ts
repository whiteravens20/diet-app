// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

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
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.mealPlan.updateMany({
      where: { id: planId, revision: readAtRevision },
      data: { revision: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        error: 'PLAN_CHANGED',
        message: 'The plan changed while this request was running. Reload it and try again.',
      });
    }
    const written = await write(tx);
    await unlinkDiverged(tx, planId);
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
