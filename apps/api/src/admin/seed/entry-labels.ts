// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import {
  labelOfAmount,
  scaleLabel,
  storedTotals,
  toStoredLabel,
  UNKNOWN_LABEL,
} from '../../engine/label-totals.js';
import { toCanonical, UnitConversionError } from '../../engine/units.js';

/** How many entries are read at a time. */
const BATCH = 500;

/**
 * Diary entries of a recipe or an ingredient that hold no fibre, sugars, salt or saturated fat (as
 * every one written before the catalogue held them) get them from the recipe or the ingredient as
 * it is now. An entry keeps the figures it was written with: only these four, which it has none
 * of, are filled in, once. Returns how many entries were given them.
 */
export async function fillEntryLabels(
  db: Pick<Prisma.TransactionClient, 'diaryEntry'>,
): Promise<number> {
  let filled = 0;
  let after: string | undefined;
  for (;;) {
    const entries = await db.diaryEntry.findMany({
      where: {
        fiber: null,
        sugars: null,
        salt: null,
        saturatedFat: null,
        OR: [
          { kind: 'recipe', recipeId: { not: null } },
          { kind: 'ingredient', ingredientId: { not: null } },
        ],
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: {
        id: true,
        servings: true,
        quantity: true,
        unit: true,
        recipe: { select: { labelPerServing: true } },
        ingredient: {
          select: {
            canonicalUnit: true,
            gramsPerPiece: true,
            density: true,
            fiberPer100: true,
            sugarsPer100: true,
            saltPer100: true,
            saturatedFatPer100: true,
          },
        },
      },
    });
    if (entries.length === 0) return filled;
    after = entries.at(-1)!.id;

    for (const entry of entries) {
      let label = UNKNOWN_LABEL;
      if (entry.recipe && entry.servings !== null) {
        label = scaleLabel(
          storedTotals(entry.recipe.labelPerServing) ?? UNKNOWN_LABEL,
          entry.servings,
        );
      } else if (entry.ingredient && entry.quantity !== null && entry.unit !== null) {
        try {
          label = labelOfAmount(
            entry.ingredient,
            toCanonical(entry.quantity, entry.unit, entry.ingredient),
          );
        } catch (err) {
          // An amount its ingredient can no longer be converted from keeps what it has: nothing.
          if (!(err instanceof UnitConversionError)) throw err;
        }
      }
      const stored = toStoredLabel(label);
      if ([stored.fiber, stored.sugars, stored.salt, stored.saturatedFat].every((g) => g === null))
        continue;
      await db.diaryEntry.update({ where: { id: entry.id }, data: stored });
      filled += 1;
    }
  }
}
