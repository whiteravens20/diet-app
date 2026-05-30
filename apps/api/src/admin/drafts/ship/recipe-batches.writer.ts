/**
 * On-disk shape for `data/recipes/<batchId>.json` + the writer the Phase E
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Difficulty,
  LocaleStringMap,
  LocaleStringsMap,
  RecipeDraftIngredientLine,
} from '@diet-app/shared';
import { Unit as UnitSchema, MealType as MealTypeSchema, DietType as DietTypeSchema } from '@diet-app/shared';

/** One recipe row as written to `data/recipes/<batchId>.json`. Matches the
 *  shape `data/recipes.json` already uses so the seeder can load both
 *  without a branch. */
export const ShippedRecipe = z.object({
  slug: z.string(),
  title: LocaleStringMap,
  description: LocaleStringMap,
  servings: z.number().int().positive(),
  mealTypes: z.array(MealTypeSchema),
  dietTags: z.array(DietTypeSchema),
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

/** Resolve the file path for one batch. */
export function recipeBatchFilePath(dataDir: string, batchId: string): string {
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

/** Read every `<batchId>.json` under `data/recipes/`, sorted by filename so
 *  the seeder is deterministic. Malformed files are skipped silently —
 *  operator-edited junk shouldn't brick the seeder. */
export function readAllRecipeBatches(dataDir: string): ShippedRecipeBatch {
  const dir = recipeBatchesDir(dataDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: ShippedRecipe[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const parsed = ShippedRecipeBatch.safeParse(raw);
      if (parsed.success) out.push(...parsed.data);
    } catch {
      // skip malformed files
    }
  }
  return out;
}

// Re-export shared Unit so the seeder's union types pick up the literal.
export { UnitSchema };
