// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * On-disk shape for `data/recipes/<batchId>.json`, which the instance's own
 * `recipes/library.json` uses as well (`instance-export.ts`).
 *
 * Source of truth on the seed side: see `seeder.ts` — `data/recipes/*.json`
 * is glob-loaded after `data/recipes.json` and appended to the recipe seed
 * pool. Each row uses the same shape `data/recipes.json` uses, so the seeder
 * doesn't need a branch.
 */
import { join } from 'node:path';
import { z } from 'zod';
import {
  Difficulty,
  LocaleStringMap,
  LocaleStringsMap,
  RecipeDraftIngredientLine,
} from '@diet-app/shared';
import { Cuisine, MealType as MealTypeSchema, WebAddress } from '@diet-app/shared';

/** One recipe row as written to `data/recipes/<batchId>.json`. Matches the
 *  shape `data/recipes.json` already uses so the seeder can load both
 *  without a branch. Like that file it holds no nutrition, allergens or
 *  diets: the loader works those out from the ingredients. */
export const ShippedRecipe = z.object({
  slug: z.string(),
  title: LocaleStringMap,
  description: LocaleStringMap,
  servings: z.number().int().positive(),
  mealTypes: z.array(MealTypeSchema),
  prepMinutes: z.number().int().nonnegative(),
  cookMinutes: z.number().int().nonnegative(),
  difficulty: Difficulty,
  cuisine: Cuisine.optional(),
  ingredients: z.array(RecipeDraftIngredientLine).min(1),
  steps: LocaleStringsMap,
  /** Where a recipe that was taken in from somewhere else is from, and its licence. Left out for a recipe written here. */
  source: z.object({ url: WebAddress.optional(), license: z.string().min(1).max(200) }).optional(),
});
export type ShippedRecipe = z.infer<typeof ShippedRecipe>;

export const RECIPE_BATCHES_DIR = 'recipes';

/** Resolve `data/recipes/`. */
export function recipeBatchesDir(dataDir: string): string {
  return join(dataDir, RECIPE_BATCHES_DIR);
}
