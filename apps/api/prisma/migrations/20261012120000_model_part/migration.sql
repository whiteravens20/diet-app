-- What a model had to do with a meal and with a recipe of a user's, kept so
-- that both can say so wherever they are shown.

-- A model chose the recipe of this meal, and why.
ALTER TABLE "PlannedMeal" ADD COLUMN "modelPicked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlannedMeal" ADD COLUMN "modelReason" TEXT;

-- A model chose the ingredient that was swapped into this recipe, or reworded
-- its text around it.
ALTER TABLE "Recipe" ADD COLUMN "modelAssisted" BOOLEAN NOT NULL DEFAULT false;

-- The recipes a model reworded before this was kept say so through their
-- text: a translation a model wrote. Recipes a model wrote whole (origin
-- 'ai') say so by their origin, and the shared library's translations are
-- people's to approve.
UPDATE "Recipe" r
   SET "modelAssisted" = true
 WHERE r."origin" = 'user'
   AND EXISTS (SELECT 1 FROM "RecipeTranslation" t WHERE t."recipeId" = r."id" AND t."source" = 'AI');
