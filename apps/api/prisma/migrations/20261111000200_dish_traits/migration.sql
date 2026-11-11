-- The taste, form and starch base of a dish: null where nobody set them.
ALTER TABLE "Recipe" ADD COLUMN "taste" TEXT;
ALTER TABLE "Recipe" ADD COLUMN "form" TEXT;
ALTER TABLE "Recipe" ADD COLUMN "starchBase" TEXT;
-- And of a draft, as it will ship.
ALTER TABLE "RecipeDraft" ADD COLUMN "taste" TEXT;
ALTER TABLE "RecipeDraft" ADD COLUMN "form" TEXT;
ALTER TABLE "RecipeDraft" ADD COLUMN "starchBase" TEXT;
