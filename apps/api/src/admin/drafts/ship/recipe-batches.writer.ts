// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * On-disk shape for `data/recipes/<batchId>.json` + the writer the
 * ship runner will call.
 *
 * One file per ship batch — never merge into a single file. Concurrent
 * batches in flight can't merge-conflict each other because each writes its
 * own filename. Re-ships of the same batch overwrite that file (last write
 * wins per batch).
 *
 * Source of truth on the seed side: see `seeder.ts` — `data/recipes/*.json`
 * is glob-loaded after `data/recipes.json` and appended to the recipe seed
 * pool. Each row uses the same shape `data/recipes.json` uses, so the seeder
 * doesn't need a branch.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Difficulty,
  LocaleStringMap,
  LocaleStringsMap,
  RecipeDraftIngredientLine,
} from '@diet-app/shared';
import { Unit as UnitSchema, MealType as MealTypeSchema } from '@diet-app/shared';

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
  ingredients: z.array(RecipeDraftIngredientLine).min(1),
  steps: LocaleStringsMap,
});
export type ShippedRecipe = z.infer<typeof ShippedRecipe>;

export const ShippedRecipeBatch = z.array(ShippedRecipe);
export type ShippedRecipeBatch = z.infer<typeof ShippedRecipeBatch>;

export const RECIPE_BATCHES_DIR = 'recipes';

/** Resolve `data/recipes/`. */
export function recipeBatchesDir(dataDir: string): string {
  return join(dataDir, RECIPE_BATCHES_DIR);
}

/** Resolve the file path for one batch. `batchId` is server-generated today
 *  (`rec-<iso>-<uuid>`, `bundle-<iso>`, a sanitised branch name), but this is a
 *  filesystem boundary — reject anything but a single safe segment so a stray
 *  `..` or path separator from a future caller can't escape `data/recipes/`. */
export function recipeBatchFilePath(dataDir: string, batchId: string): string {
  if (!batchId || /[/\\]|\.\./.test(batchId)) {
    throw new Error(`unsafe recipe batch id: ${batchId}`);
  }
  return join(recipeBatchesDir(dataDir), `${batchId}.json`);
}

/** Write a batch file. Two-space indent + trailing newline so PR diffs read
 *  cleanly; creates `data/recipes/` on first use. */
export function writeRecipeBatch(
  dataDir: string,
  batchId: string,
  rows: ShippedRecipe[],
): { path: string; count: number } {
  const dir = recipeBatchesDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = recipeBatchFilePath(dataDir, batchId);
  writeFileSync(path, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  return { path, count: rows.length };
}

// Re-export shared Unit so the seeder's union types pick up the literal.
export { UnitSchema };
