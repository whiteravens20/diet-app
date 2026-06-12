/**
 * Local-mode ship runner — default for self-hosted instances.
 *
 * Writes approved drafts directly into the live DB tables:
 *   - Recipe drafts become `Recipe` rows with `origin = 'ai'`, ingredients
 *     resolved through the live `Ingredient` table by slug, and per-locale
 *     `RecipeTranslation` rows with `source = 'MANUAL'`. Nutrition is
 *     recomputed from scratch via the deterministic engine — the writer
 *     refuses to ship a row whose engine-recomputed values disagree with
 *     the draft's persisted values by more than 1 kcal, which would mean
 *     the catalogue shifted under the draft (e.g. the ingredient's per-100
 *     macros changed) since validation.
 *   - Ingredient-name drafts become `IngredientTranslation` rows with
 *     `source = 'MANUAL'` per locale (existing seeder mechanism — the
 *     wipe-and-rewrite at the start of a re-seed only touches CURATED_JSON,
 *     so these survive).
 *
 * Sidecar files are always written under `INSTANCE_DATA_DIR/recipes/<batchId>.json`
 * and `INSTANCE_DATA_DIR/ingredient-overrides.json`. The directory is
 * gitignored. The sidecar is pure backup — no seeder reads it back in v1;
 * it exists so the operator can rsync between machines, inspect what was
 * approved, or restore from a future import script.
 *
 * On success every shipped draft row gets:
 *   - `status = 'SHIPPED'`
 *   - `shippedAt = <now>`
 *   - `shippedPRUrl = null` (no PR for local mode)
 *
 * Failure surfaces are kept additive — if writing 5 drafts of 10 succeeded
 * before a constraint violation aborts the 6th, the first 5 are already
 * committed to the DB. The runner returns counts so the controller can
 * report partial success.
 */
import { existsSync, mkdirSync } from 'node:fs';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { nutritionFor, toCanonical } from '../../../engine/units.js';
import {
  IngredientOverrideEntry,
  ingredientOverridesPath,
  mergeIngredientOverrides,
  type IngredientOverrideFile,
} from './ingredient-overrides.writer.js';
import {
  recipeBatchFilePath,
  recipeBatchesDir,
  writeRecipeBatch,
  type ShippedRecipe,
} from './recipe-batches.writer.js';

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
  skipped: { draftId: string; reason: string }[];
  /** Sidecar paths the writer touched, so the UI can show the operator
   *  where their portable backup landed. */
  sidecarPaths: string[];
  /** Set when the DB ship succeeded but the sidecar backup couldn't be
   *  written (e.g. the gitignored `instance-data` dir isn't writable by the
   *  container user). The ship is NOT failed over this — the sidecar is pure
   *  backup, the DB is the source of truth — but the operator is told so they
   *  can fix the permissions if they want the portable copy. */
  sidecarError?: string;
}

/** Ship every APPROVED recipe draft (optionally filtered by batchIds) into
 *  live `Recipe` rows + per-locale translations. Updates each draft to
 *  SHIPPED on success and writes the batch JSON to the instance-data sidecar. */
export async function shipRecipesLocal(
  prisma: PrismaService,
  request: LocalShipRequest & { kind: 'recipe' },
): Promise<LocalShipResult> {
  const where = {
    status: 'APPROVED' as const,
    ...(request.batchIds && request.batchIds.length > 0
      ? { batchId: { in: request.batchIds } }
      : {}),
  };
  const drafts = await prisma.recipeDraft.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });

  const shipped: string[] = [];
  const skipped: { draftId: string; reason: string }[] = [];
  const sidecarRows: ShippedRecipe[] = [];

  for (const d of drafts) {
    try {
      const ingredientLines = (d.ingredientsJson ?? []) as {
        slug: string;
        quantity: number;
        unit: 'g' | 'ml' | 'piece';
        note?: string | null;
      }[];
      const slugs = ingredientLines.map((l) => l.slug);
      const ingredients = await prisma.ingredient.findMany({
        where: { slug: { in: slugs } },
        select: {
          id: true,
          slug: true,
          canonicalUnit: true,
          gramsPerPiece: true,
          density: true,
          caloriesPer100: true,
          proteinPer100: true,
          fatPer100: true,
          carbsPer100: true,
          allergens: true,
        },
      });
      const bySlug = new Map(ingredients.map((i) => [i.slug!, i]));
      const missing = slugs.filter((s) => !bySlug.has(s));
      if (missing.length > 0) {
        skipped.push({
          draftId: d.id,
          reason: `unknown-slug-at-ship: ${missing.join(', ')}`,
        });
        continue;
      }

      // Engine recompute. If macros drifted > 1 kcal since draft creation
      // (catalogue edit), refuse to ship — operator should re-review.
      let calories = 0;
      let protein = 0;
      let fat = 0;
      let carbs = 0;
      const allergens = new Set<string>();
      const recipeIngredientCreate: {
        ingredientId: string;
        quantity: number;
        unit: 'g' | 'ml' | 'piece';
        note: string | null;
      }[] = [];
      for (const line of ingredientLines) {
        const ing = bySlug.get(line.slug)!;
        const canonical = toCanonical(line.quantity, line.unit, {
          canonicalUnit: ing.canonicalUnit,
          gramsPerPiece: ing.gramsPerPiece,
          density: ing.density,
        });
        const n = nutritionFor(canonical, {
          calories: ing.caloriesPer100,
          protein: ing.proteinPer100,
          fat: ing.fatPer100,
          carbs: ing.carbsPer100,
        });
        calories += n.calories;
        protein += n.protein;
        fat += n.fat;
        carbs += n.carbs;
        for (const a of ing.allergens) allergens.add(a);
        recipeIngredientCreate.push({
          ingredientId: ing.id,
          quantity: line.quantity,
          unit: line.unit,
          note: line.note ?? null,
        });
      }
      const engineKcal = Math.round(calories / d.servings);
      if (Math.abs(engineKcal - d.caloriesPerServing) > 1) {
        skipped.push({
          draftId: d.id,
          reason: `nutrition-drift-since-draft: draft=${d.caloriesPerServing} now=${engineKcal}`,
        });
        continue;
      }

      const titles = (d.titles ?? {}) as Record<string, string>;
      const descriptions = (d.descriptions ?? {}) as Record<string, string>;
      const stepsByLocale = (d.steps ?? {}) as Record<string, string[]>;
      const enTitle = titles.en ?? d.slug;
      const enDesc = descriptions.en ?? '';
      const enSteps = stepsByLocale.en ?? [];

      const fields = {
        title: enTitle,
        description: enDesc,
        steps: enSteps,
        servings: d.servings,
        mealTypes: d.mealTypes,
        dietTags: d.dietTags,
        prepMinutes: d.prepMinutes,
        cookMinutes: d.cookMinutes,
        difficulty: d.difficulty,
        allergens: [...allergens].sort(),
        caloriesPerServing: engineKcal,
        proteinPerServing: Math.round(protein / d.servings),
        fatPerServing: Math.round(fat / d.servings),
        carbsPerServing: Math.round(carbs / d.servings),
      };

      const existing = await prisma.recipe.findFirst({ where: { slug: d.slug } });
      const recipe = existing
        ? await prisma.recipe.update({
            where: { id: existing.id },
            data: {
              ...fields,
              origin: 'ai',
              ingredients: { deleteMany: {}, create: recipeIngredientCreate },
            },
          })
        : await prisma.recipe.create({
            data: {
              slug: d.slug,
              origin: 'ai',
              ...fields,
              ingredients: { create: recipeIngredientCreate },
            },
          });

      // Per-locale translations. Wipe only MANUAL rows for this recipe so a
      // re-ship of an existing slug doesn't accumulate stale translations,
      // and the seeder's CURATED_JSON rows (if any) survive untouched.
      await prisma.recipeTranslation.deleteMany({
        where: { recipeId: recipe.id, source: 'MANUAL' },
      });
      for (const locale of d.locales) {
        await prisma.recipeTranslation.create({
          data: {
            recipeId: recipe.id,
            locale,
            title: titles[locale] ?? enTitle,
            description: descriptions[locale] ?? enDesc,
            steps: stepsByLocale[locale] ?? enSteps,
            source: 'MANUAL',
          },
        });
      }

      await prisma.recipeDraft.update({
        where: { id: d.id },
        data: {
          status: 'SHIPPED',
          shippedAt: new Date(),
          shippedPRUrl: null,
        },
      });
      shipped.push(d.id);

      sidecarRows.push({
        slug: d.slug,
        title: titles,
        description: descriptions,
        servings: d.servings,
        mealTypes: d.mealTypes as ShippedRecipe['mealTypes'],
        dietTags: d.dietTags as ShippedRecipe['dietTags'],
        prepMinutes: d.prepMinutes,
        cookMinutes: d.cookMinutes,
        difficulty: d.difficulty,
        ingredients: ingredientLines.map((l) => ({
          slug: l.slug,
          quantity: l.quantity,
          unit: l.unit,
          note: l.note ?? null,
        })),
        steps: stepsByLocale,
      });
    } catch (err) {
      skipped.push({
        draftId: d.id,
        reason: `db-write-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const sidecarPaths: string[] = [];
  let sidecarError: string | undefined;
  if (sidecarRows.length > 0) {
    try {
      const batchId = newSidecarBatchId();
      if (!existsSync(recipeBatchesDir(request.instanceDataDir))) {
        mkdirSync(recipeBatchesDir(request.instanceDataDir), { recursive: true });
      }
      const written = writeRecipeBatch(request.instanceDataDir, batchId, sidecarRows);
      sidecarPaths.push(written.path);
    } catch (err) {
      sidecarError = err instanceof Error ? err.message : String(err);
    }
  }

  return { kind: 'recipe', shippedDraftIds: shipped, skipped, sidecarPaths, sidecarError };
}

/** Ship every APPROVED ingredient-name draft into per-locale
 *  `IngredientTranslation` rows with `source = 'MANUAL'`. Also merges into the
 *  sidecar `ingredient-overrides.json` so the operator has a portable copy. */
export async function shipIngredientNamesLocal(
  prisma: PrismaService,
  request: LocalShipRequest & { kind: 'ingredient-name' },
): Promise<LocalShipResult> {
  const where = {
    status: 'APPROVED' as const,
    ...(request.batchIds && request.batchIds.length > 0
      ? { batchId: { in: request.batchIds } }
      : {}),
  };
  const drafts = await prisma.ingredientNameDraft.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });

  const shipped: string[] = [];
  const skipped: { draftId: string; reason: string }[] = [];
  const additions: IngredientOverrideFile = {};

  for (const d of drafts) {
    try {
      const parsed = IngredientOverrideEntry.safeParse(d.suggestions);
      if (!parsed.success) {
        skipped.push({ draftId: d.id, reason: 'suggestions-shape-invalid' });
        continue;
      }
      const target = await prisma.ingredient.findFirst({
        where: { slug: d.ingredientSlug },
        select: { id: true },
      });
      if (!target) {
        skipped.push({ draftId: d.id, reason: `unknown-slug: ${d.ingredientSlug}` });
        continue;
      }

      const storageHintMap = (parsed.data.storageHint ?? {}) as Record<string, string>;
      for (const [locale, name] of Object.entries(parsed.data.name as Record<string, string>)) {
        const storageHint = storageHintMap[locale] ?? null;
        await prisma.ingredientTranslation.upsert({
          where: { ingredientId_locale: { ingredientId: target.id, locale } },
          create: { ingredientId: target.id, locale, name, storageHint, source: 'MANUAL' },
          update: { name, storageHint, source: 'MANUAL' },
        });
      }

      await prisma.ingredientNameDraft.update({
        where: { id: d.id },
        data: { status: 'SHIPPED', shippedAt: new Date(), shippedPRUrl: null },
      });
      shipped.push(d.id);
      additions[d.ingredientSlug] = parsed.data;
    } catch (err) {
      skipped.push({
        draftId: d.id,
        reason: `db-write-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

// Re-export sidecar path helpers so the controller can render the location in
// the response without re-importing the writer module directly.
export { recipeBatchFilePath, ingredientOverridesPath };
