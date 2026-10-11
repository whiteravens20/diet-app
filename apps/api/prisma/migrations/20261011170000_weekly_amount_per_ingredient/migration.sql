-- The most of one ingredient, in grams or millilitres, that the meals of any
-- seven days of a plan may hold together.
ALTER TABLE "ProfilePreference" ADD COLUMN "maxWeeklyAmountPerIngredient" INTEGER NOT NULL DEFAULT 3000;
