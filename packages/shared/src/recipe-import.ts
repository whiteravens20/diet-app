// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { MOST_IMPORT_BYTES } from './constants.js';
import { MealType } from './enums.js';
import { WebAddress } from './recipe.js';

/**
 * What `POST /api/admin/drafts/recipes/import` is given: the text of a JSON
 * document of recipes written as schema.org `Recipe` (one, a list, or a
 * `@graph` that holds some), and what holds for a recipe of it that does not
 * say so itself: where it is from, the licence it may be passed on under,
 * and the meals it is for. The API reads the text itself, and answers 400
 * `IMPORT_NOT_JSON` for one that is no JSON object or list.
 *
 * A recipe that names no licence, in an import that names none either, is
 * not taken: whoever imports answers for the right to pass a recipe on.
 */
export const RecipeImportRequest = z
  .object({
    document: z.string().min(1).max(MOST_IMPORT_BYTES),
    sourceUrl: WebAddress.optional(),
    license: z.string().trim().min(1).max(200).optional(),
    mealTypes: z.array(MealType).min(1).max(MealType.options.length).optional(),
    /** Say what would become a draft and what would be refused, and write nothing. */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type RecipeImportRequest = z.infer<typeof RecipeImportRequest>;

/**
 * A recipe an import did not take, and why: each reason as `<rule>` or
 * `<rule>: <what it is about>`, a rule a client words in the reader's
 * language. It never reached the queue.
 */
export const ImportRejection = z.object({
  title: z.string(),
  sourceUrl: z.string().nullable(),
  reasons: z.array(z.string()).min(1),
});
export type ImportRejection = z.infer<typeof ImportRejection>;

/** A rejection as it is kept, for the administrator to look through after the import. */
export const StoredImportRejection = ImportRejection.extend({
  id: z.string().uuid(),
  batchId: z.string(),
  createdAt: z.string().datetime(),
});
export type StoredImportRejection = z.infer<typeof StoredImportRejection>;

export const RecipeImportResult = z.object({
  /** The batch the drafts and the rejections of the import are under; null for a dry run. */
  batchId: z.string().nullable(),
  /** How many recipes the document held. Those after the first `MOST_RECIPES_PER_IMPORT` were not looked at. */
  found: z.number().int().nonnegative(),
  /** The recipes that became drafts, or would. */
  drafted: z.array(z.object({ slug: z.string(), title: z.string() })),
  /** The recipes that were looked at and not taken. */
  rejected: z.array(ImportRejection),
  dryRun: z.boolean(),
});
export type RecipeImportResult = z.infer<typeof RecipeImportResult>;
