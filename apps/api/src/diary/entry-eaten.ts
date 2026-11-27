// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { canonical } from '../inventory/eaten-pantry.js';

type Tx = Prisma.TransactionClient;

/** What converting a line of what an entry ate reads of its ingredient. */
const CONVERTED = { canonicalUnit: true, gramsPerPiece: true, density: true } as const;

/**
 * What an entry of the diary ate, by ingredient in its canonical unit: an ingredient's entry its amount, a recipe's
 * entry the recipe's lines in the servings eaten. Other entries, and one whose food has left the catalogue, ate
 * nothing the pantry holds.
 */
export async function entryEaten(
  db: Pick<Tx, 'ingredient' | 'recipe'>,
  entry: {
    kind: string;
    ingredientId: string | null;
    recipeId: string | null;
    quantity: number | null;
    unit: string | null;
    servings: number | null;
  },
): Promise<Map<string, number>> {
  const eaten = new Map<string, number>();
  const add = (ingredientId: string, amount: number | null): void => {
    if (amount !== null && amount > 0)
      eaten.set(ingredientId, (eaten.get(ingredientId) ?? 0) + amount);
  };
  if (entry.kind === 'ingredient' && entry.ingredientId && entry.quantity && entry.unit) {
    const ingredient = await db.ingredient.findUnique({
      where: { id: entry.ingredientId },
      select: CONVERTED,
    });
    if (ingredient) add(entry.ingredientId, canonical(entry.quantity, entry.unit, ingredient));
  }
  if (entry.kind === 'recipe' && entry.recipeId && entry.servings) {
    const recipe = await db.recipe.findUnique({
      where: { id: entry.recipeId },
      select: {
        servings: true,
        ingredients: {
          select: {
            ingredientId: true,
            quantity: true,
            unit: true,
            ingredient: { select: CONVERTED },
          },
        },
      },
    });
    if (recipe && recipe.servings > 0)
      for (const line of recipe.ingredients)
        add(
          line.ingredientId,
          canonical((line.quantity * entry.servings) / recipe.servings, line.unit, line.ingredient),
        );
  }
  return eaten;
}
