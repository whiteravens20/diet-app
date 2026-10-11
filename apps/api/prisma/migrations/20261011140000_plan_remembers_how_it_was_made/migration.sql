-- A plan keeps what it was asked for, and the random value the choices of its
-- last generation were drawn with.
ALTER TABLE "MealPlan" ADD COLUMN "options" JSONB, ADD COLUMN "seed" INTEGER NOT NULL DEFAULT 0;

-- A plan made before this was kept is made again as it was until now:
-- everything left to the profile, with the most repeats of a recipe it was given.
UPDATE "MealPlan" SET "options" = jsonb_build_object(
  'dietType', NULL,
  'mealCount', NULL,
  'calorieTargetOverride', NULL,
  'mealPrepFriendly', false,
  'respectExclusions', true,
  'respectFavorites', true,
  'respectInventory', true,
  'maxRepeatsPerRecipe', "maxRepeatsPerRecipe"
);

ALTER TABLE "MealPlan"
  ALTER COLUMN "options" SET NOT NULL,
  ALTER COLUMN "seed" DROP DEFAULT,
  DROP COLUMN "maxRepeatsPerRecipe";
