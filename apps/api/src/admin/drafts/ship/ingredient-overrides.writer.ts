// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * On-disk shape for `data/ingredient-overrides.json`, which the instance's
 * own files use as well (`instance-export.ts` writes theirs from the
 * database), and the reader of such a file.
 *
 * Source of truth on the seed side: see `seeder.ts` — the file is read after
 * the ingredient upsert pass and applied as `source = MANUAL`
 * IngredientTranslation rows.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Convenience for callers that already have the data dir. */
export function ingredientOverridesPath(dataDir: string): string {
  return join(dataDir, INGREDIENT_OVERRIDES_FILE);
}
