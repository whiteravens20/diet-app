// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the plates of the dishes both people of a joint plan eat are read from:
 * the recipes served on a plate, part by part (`engine/plates.ts`).
 */
import type { Prisma } from '@prisma/client';
import type { Unit } from '@diet-app/shared';
import { proposeTraits, traitsOf } from '../engine/dish-traits.js';
import {
  partOf,
  type PartFigures,
  type PlateDish,
  type PlateLabel,
  type PlatePart,
} from '../engine/plates.js';
import { toCanonical, UnitConversionError } from '../engine/units.js';

const PARTS: readonly PlatePart[] = ['protein', 'starch', 'vegetables', 'rest'];

/**
 * The recipes asked for that are served on a plate, as their traits say (those
 * set on each, the rest proposed), each with what a serving of each of its
 * parts holds and the part of each of its ingredients. A line whose amount
 * cannot be told in its ingredient's unit counts for nothing, as in the
 * recipe's own figures.
 */
export async function plateDishesOf(
  db: Pick<Prisma.TransactionClient, 'recipe'>,
  recipeIds: readonly string[],
): Promise<Map<string, PlateDish>> {
  if (recipeIds.length === 0) return new Map();
  const recipes = await db.recipe.findMany({
    where: { id: { in: [...new Set(recipeIds)] } },
    select: {
      id: true,
      title: true,
      servings: true,
      taste: true,
      form: true,
      starchBase: true,
      translations: { select: { title: true } },
      ingredients: {
        select: {
          ingredientId: true,
          quantity: true,
          unit: true,
          ingredient: {
            select: {
              slug: true,
              name: true,
              category: true,
              proteinKind: true,
              canonicalUnit: true,
              gramsPerPiece: true,
              density: true,
              caloriesPer100: true,
              proteinPer100: true,
              fatPer100: true,
              carbsPer100: true,
              fiberPer100: true,
              sugarsPer100: true,
              saltPer100: true,
              saturatedFatPer100: true,
            },
          },
        },
      },
    },
  });
  const dishes = new Map<string, PlateDish>();
  for (const recipe of recipes) {
    const lines = recipe.ingredients.map((line) => ({
      ...line,
      unit: line.unit as Unit,
      ingredient: { ...line.ingredient, canonicalUnit: line.ingredient.canonicalUnit as Unit },
    }));
    const { form } = traitsOf(recipe, () =>
      proposeTraits(
        [recipe.title, ...recipe.translations.map((translation) => translation.title)],
        lines,
      ),
    );
    if (form !== 'plate') continue;
    const parts = Object.fromEntries(
      PARTS.map((part) => [part, { calories: 0, protein: 0, fat: 0, carbs: 0 }]),
    ) as Record<PlatePart, PartFigures>;
    const labels = Object.fromEntries(
      PARTS.map((part) => [part, { fiber: 0, sugars: 0, salt: 0, saturatedFat: 0 }]),
    ) as Record<PlatePart, PlateLabel>;
    const partOfIngredient = new Map<string, PlatePart>();
    const servings = Math.max(1, recipe.servings);
    for (const line of lines) {
      const part = partOf(line.ingredient);
      partOfIngredient.set(line.ingredientId, part);
      let amount: number;
      try {
        amount = toCanonical(line.quantity, line.unit, line.ingredient) / servings;
      } catch (err) {
        if (err instanceof UnitConversionError) continue;
        throw err;
      }
      const food = line.ingredient;
      const per = amount / 100;
      parts[part].calories += food.caloriesPer100 * per;
      parts[part].protein += food.proteinPer100 * per;
      parts[part].fat += food.fatPer100 * per;
      parts[part].carbs += food.carbsPer100 * per;
      labels[part].fiber += (food.fiberPer100 ?? 0) * per;
      labels[part].sugars += (food.sugarsPer100 ?? 0) * per;
      labels[part].salt += (food.saltPer100 ?? 0) * per;
      labels[part].saturatedFat += (food.saturatedFatPer100 ?? 0) * per;
    }
    dishes.set(recipe.id, { parts, labels, partOf: partOfIngredient });
  }
  return dishes;
}
