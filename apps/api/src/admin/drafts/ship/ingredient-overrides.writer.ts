/**
 * On-disk shape for `data/ingredient-overrides.json` + the merge helper the
 * Phase E ship runner will call.
 *
 * The file is slug-keyed and additive: one approved draft per slug at a time,
 * subsequent ships merge on top (last write wins per slug). This makes
 * concurrent batches mergeable in git, and means a re-ship for a slug just
 * supersedes whatever was there before.
 *
 * Source of truth on the seed side: see `seeder.ts` — the file is read after
 * the ingredient upsert pass and applied as `source = MANUAL`
 * IngredientTranslation rows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Locale } from '@diet-app/shared';

/** Per-locale string map; same shape the validator hands us. Uses
 *  `partialRecord` because drafts are generated for a locale subset
 *  (`targetLocales`, e.g. `['pl']` — EN is the canonical source, not a draft
 *  target). Zod v4's `z.record` over an enum key is exhaustive and would reject
 *  a `{ pl: … }` map for the missing `en` key, failing every ship with
 *  `suggestions-shape-invalid`. Matches `IngredientNameSuggestion` in shared. */
const LocaleStringMap = z.partialRecord(Locale, z.string().min(1));

/** Shape of one slug's override row. */
export const IngredientOverrideEntry = z.object({
  name: LocaleStringMap,
  storageHint: LocaleStringMap.optional(),
});
export type IngredientOverrideEntry = z.infer<typeof IngredientOverrideEntry>;

/** Whole-file shape: slug → entry. */
export const IngredientOverrideFile = z.record(z.string(), IngredientOverrideEntry);
export type IngredientOverrideFile = z.infer<typeof IngredientOverrideFile>;

export const INGREDIENT_OVERRIDES_FILE = 'ingredient-overrides.json';

/** Read the override file at `path` if it exists, returning the parsed
 *  object (or `{}` when absent / malformed — operator-edited files mustn't
 *  brick the seeder). */
export function readIngredientOverrides(path: string): IngredientOverrideFile {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = IngredientOverrideFile.safeParse(raw);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Merge `additions` into the file at `path` and write it back. Deterministic
 *  output: keys sorted, two-space indent, trailing newline — keeps PR diffs
 *  reviewable. Used by the Phase E ship runner. */
export function mergeIngredientOverrides(
  path: string,
  additions: IngredientOverrideFile,
): { written: number; total: number } {
  const existing = readIngredientOverrides(path);
  const merged: IngredientOverrideFile = { ...existing };
  let written = 0;
  for (const [slug, entry] of Object.entries(additions)) {
    merged[slug] = entry;
    written += 1;
  }
  // Sort keys for stable output.
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
  );
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  return { written, total: Object.keys(sorted).length };
}

/** Convenience for callers that already have the data dir. */
export function ingredientOverridesPath(dataDir: string): string {
  return join(dataDir, INGREDIENT_OVERRIDES_FILE);
}
