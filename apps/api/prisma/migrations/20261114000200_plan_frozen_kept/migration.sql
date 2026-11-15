-- The rests of meat and fish a plan freezes that were added to the pantry, each once.
ALTER TABLE "MealPlan" ADD COLUMN "frozenKept" JSONB NOT NULL DEFAULT '[]';
