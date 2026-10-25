// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Shipping into this instance: approved drafts become rows of the live
 * tables, at once.
 *
 *  - A recipe draft becomes a recipe of the shared library (`library.ts`),
 *    with its text stored as approved by people. It is refused when the
 *    figures moved since it was reviewed, or when it would take the place of
 *    another recipe. A draft of a recipe the library already has of its own
 *    gives that recipe its other languages, and is refused when the recipe
 *    has changed since.
 *  - The draft of an ingredient's name becomes that ingredient's name in the
 *    languages the draft was reviewed in, stored as approved by people, which
 *    an update of the catalogue leaves alone.
 *
 * Each draft ships in a transaction of its own that first locks the draft, as
 * a review and an edit do: a draft that was edited a moment before is read as
 * the edit left it, and is not shipped unless it is still approved. A draft
 * that does not ship stays in the queue, and the reason is reported.
 *
 * What shipped is also written to the instance's own data directory, in the
 * shape of the catalogue's data files: `recipes/<batch>.json` and
 * `ingredient-overrides.json`. Those files are the instance's copy of what it
 * added to the catalogue; `restore.ts` reads them back into an empty database.
 * A ship does not fail when they cannot be written, and says so.
 */
import { existsSync, mkdirSync } from 'node:fs';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { RecipeProblem } from '../../../recipes/recipe-rules.js';
import { lockIngredientNameDraft, lockRecipeDraft } from '../draft-lock.js';
import type { RecipeDraftRow } from '../drafts.mapper.js';
import {
  ingredientOverridesPath,
  mergeIngredientOverrides,
  type IngredientOverrideEntry,
  type IngredientOverrideFile,
} from './ingredient-overrides.writer.js';
import { addLanguages, assessForLibrary, sameLibraryRecipe, writeToLibrary } from './library.js';
import { recipeBatchesDir, writeRecipeBatch, type ShippedRecipe } from './recipe-batches.writer.js';
import { shippableIngredientName, shippableRecipe, type Skipped } from './shippable.js';

export interface LocalShipRequest {
  kind: 'recipe' | 'ingredient-name';
  /** Optional batch filter; when omitted, every APPROVED row of the kind ships. */
  batchIds?: string[];
  /** Absolute path to the operator's instance-data dir (gitignored). */
  instanceDataDir: string;
}

export interface LocalShipResult {
  kind: 'recipe' | 'ingredient-name';
  shippedDraftIds: string[];
  skipped: Skipped[];
  /** The files of the instance's data directory that were written. */
  sidecarPaths: string[];
  /** Why those files could not be written, when they could not. The ship itself stands. */
  sidecarError?: string;
}

/** One recipe draft into the library: what shipped, or why it did not. */
export type RecipeShipOutcome =
  | { ok: true; draft: RecipeDraftRow; content: ShippedRecipe }
  | { ok: false; reason: string; problems?: RecipeProblem[] };

const approved = (request: LocalShipRequest) => ({
  status: 'APPROVED' as const,
  ...(request.batchIds && request.batchIds.length > 0 ? { batchId: { in: request.batchIds } } : {}),
});

const failure = (err: unknown): string =>
  `db-write-failed: ${err instanceof Error ? err.message : String(err)}`;

/**
 * Ship one recipe draft into the shared library, if it is approved when its
 * turn comes. The recipe it became is recorded on the draft.
 */
export function shipRecipeDraftLocal(
  prisma: PrismaService,
  id: string,
): Promise<RecipeShipOutcome> {
  return prisma.$transaction(async (tx): Promise<RecipeShipOutcome> => {
    await lockRecipeDraft(tx, id);
    const draft = await tx.recipeDraft.findUnique({ where: { id } });
    if (!draft) return { ok: false, reason: 'draft-gone' };
    if (draft.status !== 'APPROVED') return { ok: false, reason: `not-approved: ${draft.status}` };

    // Held to the rules of every recipe once more: a draft approved before a
    // rule existed does not ship until it is edited.
    const shippable = shippableRecipe(draft);
    if (!shippable.ok) return shippable;
    // A draft of a recipe the library has is that recipe in more languages: its text is added, and nothing else is written.
    const same = await sameLibraryRecipe(tx, shippable.content);
    if (same === 'changed') return { ok: false, reason: `library-recipe-changed: ${draft.slug}` };
    let recipeId: string;
    if (same) {
      await addLanguages(tx, same.id, shippable.content);
      recipeId = same.id;
    } else {
      const assessed = await assessForLibrary(tx, shippable.content, { reviewed: draft });
      if (!assessed.ok) return assessed;
      recipeId = await writeToLibrary(tx, assessed.recipe);
    }
    const shipped = await tx.recipeDraft.update({
      where: { id },
      data: {
        status: 'SHIPPED',
        shippedAt: new Date(),
        promotedRecipeId: recipeId,
      },
      include: { localeReviews: true },
    });
    return { ok: true, draft: shipped, content: shippable.content };
  });
}

/** Write the recipes that shipped as one batch of the instance's data directory. */
export function writeRecipeSidecar(
  instanceDataDir: string,
  rows: ShippedRecipe[],
): Pick<LocalShipResult, 'sidecarPaths' | 'sidecarError'> {
  if (rows.length === 0) return { sidecarPaths: [] };
  try {
    if (!existsSync(recipeBatchesDir(instanceDataDir)))
      mkdirSync(recipeBatchesDir(instanceDataDir), { recursive: true });
    return { sidecarPaths: [writeRecipeBatch(instanceDataDir, newSidecarBatchId(), rows).path] };
  } catch (err) {
    return { sidecarPaths: [], sidecarError: err instanceof Error ? err.message : String(err) };
  }
}

/** Ship every approved recipe draft, or those of the given batches, into the shared library. */
export async function shipRecipesLocal(
  prisma: PrismaService,
  request: LocalShipRequest & { kind: 'recipe' },
): Promise<LocalShipResult> {
  const drafts = await prisma.recipeDraft.findMany({
    where: approved(request),
    orderBy: { createdAt: 'asc' },
    select: { id: true, slug: true },
  });

  const shipped: string[] = [];
  const skipped: Skipped[] = [];
  const rows: ShippedRecipe[] = [];
  for (const { id, slug } of drafts) {
    let outcome: RecipeShipOutcome;
    try {
      outcome = await shipRecipeDraftLocal(prisma, id);
    } catch (err) {
      outcome = { ok: false, reason: failure(err) };
    }
    if (outcome.ok) {
      shipped.push(id);
      rows.push(outcome.content);
    } else skipped.push({ draftId: id, slug, reason: outcome.reason });
  }

  return {
    kind: 'recipe',
    shippedDraftIds: shipped,
    skipped,
    ...writeRecipeSidecar(request.instanceDataDir, rows),
  };
}

/** One draft of an ingredient's name into that ingredient's names: the entry that shipped, or why none did. */
function shipIngredientNameDraftLocal(
  prisma: PrismaService,
  id: string,
): Promise<{ ok: true; entry: IngredientOverrideEntry } | { ok: false; reason: string }> {
  return prisma.$transaction(async (tx) => {
    await lockIngredientNameDraft(tx, id);
    const draft = await tx.ingredientNameDraft.findUnique({ where: { id } });
    if (!draft) return { ok: false as const, reason: 'draft-gone' };
    if (draft.status !== 'APPROVED')
      return { ok: false as const, reason: `not-approved: ${draft.status}` };

    // Only the names of the draft's own languages ship: the others were never
    // before a reviewer.
    const shippable = shippableIngredientName(draft);
    if (!shippable.ok) return shippable;
    const entry = shippable.content;
    const target = await tx.ingredient.findFirst({
      where: { slug: draft.ingredientSlug },
      select: { id: true },
    });
    if (!target) return { ok: false as const, reason: `unknown-slug: ${draft.ingredientSlug}` };

    const hints: Record<string, string> = entry.storageHint ?? {};
    for (const [locale, name] of Object.entries(entry.name)) {
      const storageHint = hints[locale] ?? null;
      await tx.ingredientTranslation.upsert({
        where: { ingredientId_locale: { ingredientId: target.id, locale } },
        create: { ingredientId: target.id, locale, name, storageHint, source: 'MANUAL' },
        update: { name, storageHint, source: 'MANUAL' },
      });
    }
    await tx.ingredientNameDraft.update({
      where: { id },
      data: { status: 'SHIPPED', shippedAt: new Date() },
    });
    return { ok: true as const, entry };
  });
}

/** Ship every approved draft of an ingredient's name, or those of the given batches. */
export async function shipIngredientNamesLocal(
  prisma: PrismaService,
  request: LocalShipRequest & { kind: 'ingredient-name' },
): Promise<LocalShipResult> {
  const drafts = await prisma.ingredientNameDraft.findMany({
    where: approved(request),
    orderBy: { createdAt: 'asc' },
    select: { id: true, ingredientSlug: true },
  });

  const shipped: string[] = [];
  const skipped: Skipped[] = [];
  const additions: IngredientOverrideFile = {};
  for (const { id, ingredientSlug } of drafts) {
    let outcome: Awaited<ReturnType<typeof shipIngredientNameDraftLocal>>;
    try {
      outcome = await shipIngredientNameDraftLocal(prisma, id);
    } catch (err) {
      outcome = { ok: false, reason: failure(err) };
    }
    if (outcome.ok) {
      shipped.push(id);
      additions[ingredientSlug] = outcome.entry;
    } else skipped.push({ draftId: id, slug: ingredientSlug, reason: outcome.reason });
  }

  const sidecarPaths: string[] = [];
  let sidecarError: string | undefined;
  if (Object.keys(additions).length > 0) {
    try {
      const path = ingredientOverridesPath(request.instanceDataDir);
      mergeIngredientOverrides(path, additions);
      sidecarPaths.push(path);
    } catch (err) {
      sidecarError = err instanceof Error ? err.message : String(err);
    }
  }

  return { kind: 'ingredient-name', shippedDraftIds: shipped, skipped, sidecarPaths, sidecarError };
}

function newSidecarBatchId(): string {
  return `ship-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}
