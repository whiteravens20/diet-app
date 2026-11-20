-- What packs a plan opens and does not finish leave that was added to the pantry, each once.
ALTER TABLE "MealPlan" ADD COLUMN "packsKept" JSONB NOT NULL DEFAULT '[]';
