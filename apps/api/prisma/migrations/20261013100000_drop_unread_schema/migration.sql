-- What nothing reads or writes: a copy of each ingredient's figures, a list
-- of allergens, a mark on a provider configuration that no path ever set,
-- and a kind of draft nothing makes.
DROP TABLE "NutritionFact";
DROP TABLE "Allergen";
ALTER TABLE "AiProviderConfig" DROP COLUMN "isAdminDefault";

-- No path wrote a draft as MANUAL. A row marked so by hand is a model's
-- draft like the others, so that the kind can go.
UPDATE "RecipeDraft" SET "source" = 'AI' WHERE "source" = 'MANUAL';
UPDATE "IngredientNameDraft" SET "source" = 'AI' WHERE "source" = 'MANUAL';
ALTER TYPE "DraftSource" RENAME TO "DraftSource_old";
CREATE TYPE "DraftSource" AS ENUM ('AI', 'EXTERNAL', 'AI_USER');
ALTER TABLE "RecipeDraft" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "RecipeDraft" ALTER COLUMN "source" TYPE "DraftSource" USING ("source"::text::"DraftSource");
ALTER TABLE "RecipeDraft" ALTER COLUMN "source" SET DEFAULT 'AI';
ALTER TABLE "IngredientNameDraft" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "IngredientNameDraft" ALTER COLUMN "source" TYPE "DraftSource" USING ("source"::text::"DraftSource");
ALTER TABLE "IngredientNameDraft" ALTER COLUMN "source" SET DEFAULT 'AI';
DROP TYPE "DraftSource_old";
