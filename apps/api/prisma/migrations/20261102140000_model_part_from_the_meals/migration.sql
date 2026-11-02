-- Whether a model had a part in a plan is read from what its meals hold now.
ALTER TABLE "MealPlan" DROP COLUMN "generationMode";
DROP TYPE "GenerationMode";
