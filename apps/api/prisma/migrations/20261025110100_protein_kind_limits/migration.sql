-- The limits on one kind of protein in the meals of a day and of seven days, in
-- the place of the most grams of one ingredient in seven days. A profile has
-- none of the new limits until it sets them.
ALTER TABLE "ProfilePreference" DROP COLUMN "maxWeeklyAmountPerIngredient",
  ADD COLUMN "maxMealsPerDaySameKind" INTEGER,
  ADD COLUMN "maxMealsPerWeekSameKind" INTEGER,
  ADD COLUMN "kindLimits" JSONB NOT NULL DEFAULT '[]';
