-- A recipe a user writes by hand, and the new version an edit makes.
ALTER TYPE "RecipeOrigin" ADD VALUE 'manual';

ALTER TABLE "Recipe" ADD COLUMN "edited" BOOLEAN NOT NULL DEFAULT false;
