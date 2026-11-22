// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { RecipeDietTag } from '@diet-app/shared';

/**
 * The query condition for "recipes that may be planned for `diet`": the
 * database's side of `fitsDiet`. A diet that a recipe has to qualify for
 * narrows the query to recipes tagged with it; any other diet takes them all.
 */
export function recipesForDiet(diet: string): Prisma.RecipeWhereInput {
  return RecipeDietTag.safeParse(diet).success ? { dietTags: { has: diet } } : {};
}

/**
 * The query condition for "ingredients a dish for `diet` may hold": the ingredients' side of
 * `recipesForDiet`. A diet a recipe has to qualify for narrows them to those the catalogue marks as
 * fitting it; any other diet (balanced, high-protein, custom) is a matter of how a day is put together,
 * and takes every ingredient.
 */
export function ingredientsForDiet(diet: string): Prisma.IngredientWhereInput {
  return RecipeDietTag.safeParse(diet).success ? { dietCompatibility: { has: diet } } : {};
}
