-- Hard caps the meal-plan generator must respect when picking a recipe for
-- a slot. Prevents the optimiser's positive-feedback loop from filling 28
-- consecutive days with the same recipe.
ALTER TABLE "ProfilePreference"
  ADD COLUMN "maxConsecutiveDaysSameMeal" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "maxTimesPerWeekSameMeal"    INTEGER NOT NULL DEFAULT 3;
