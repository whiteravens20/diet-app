-- Phase I: user-generated recipes flow into the curation queue.
--
-- AI_USER drafts are snapshots of personal Recipe rows (from /recipes/ai-draft
-- and applyIngredientSwap) queued for translation polish and optional
-- promotion to curated. The personal Recipe row stays authoritative for the
-- user's plan; the draft is a parallel row whose only output is (a) better
-- locale translations and (b) optional promotion into data/recipes/.

ALTER TYPE "DraftSource" ADD VALUE 'AI_USER';

-- Origin for recipes promoted from an AI_USER draft to the curated set. Treated
-- like `seed` by the dedup chain (matches before drafts are checked) and ships
-- into data/recipes/promoted.json so the next re-seed turns it into a regular
-- seed row deterministically.
ALTER TYPE "RecipeOrigin" ADD VALUE 'curated';

-- Fingerprint = SHA256 of canonical (ingredientSlug, unit, normalizedQuantity)
-- tuples + mealTypes + dietTags + servings. Single source of truth for dedup
-- across curated Recipes, personal Recipes, and pending drafts. Nullable so
-- pre-existing admin-batch drafts (without computed fingerprints) coexist
-- with new rows; a backfill helper populates them lazily.
ALTER TABLE "RecipeDraft"
  ADD COLUMN "fingerprint" TEXT,
  ADD COLUMN "sourceRecipeIds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "promotedRecipeId" TEXT;

-- Partial unique index: enforces "one draft per fingerprint" while allowing
-- legacy rows with NULL fingerprint to coexist.
CREATE UNIQUE INDEX "RecipeDraft_fingerprint_key"
  ON "RecipeDraft"("fingerprint")
  WHERE "fingerprint" IS NOT NULL;

-- Lookup for "all AI_USER drafts triggered by this user" (audit + future per-
-- user review queue).
CREATE INDEX "RecipeDraft_createdByUserId_idx"
  ON "RecipeDraft"("createdByUserId");

-- Denormalised fingerprint on Recipe so the dedup chain can short-circuit at
-- curated rows without going through RecipeDraft.promotedRecipeId. Populated
-- by the engine on every new write; the seeder backfills curated rows on its
-- next run. Nullable for legacy seed rows that have not yet been re-seeded.
ALTER TABLE "Recipe"
  ADD COLUMN "fingerprint" TEXT,
  -- Soft-delete column: users can delete their own AI-drafted or swap-variant
  -- recipes; existing planned meals keep referencing the row so historical
  -- plans stay intact. All read endpoints filter `deletedAt IS NULL` except
  -- the meal-plan loader (which needs the row even after deletion).
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Recipe_fingerprint_key"
  ON "Recipe"("fingerprint")
  WHERE "fingerprint" IS NOT NULL;

-- Hot path: "list this user's non-deleted recipes" for the My Recipes tab.
CREATE INDEX "Recipe_createdByUserId_deletedAt_idx"
  ON "Recipe"("createdByUserId", "deletedAt");
