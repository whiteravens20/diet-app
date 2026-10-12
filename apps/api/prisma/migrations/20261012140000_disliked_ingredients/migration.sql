-- What a profile would rather not eat is ingredients of the catalogue from
-- now on, which a planner can look for in a recipe. What was kept before was
-- free text that nothing read and no screen could set: it names no
-- ingredient, and goes.
ALTER TABLE "ProfilePreference" DROP COLUMN "dislikedFoods",
ADD COLUMN     "dislikedIngredientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
