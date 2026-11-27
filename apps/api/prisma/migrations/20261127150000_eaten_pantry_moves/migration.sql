-- What eating took off the pantry, as the user confirmed it, by ingredient: given back by undoing it.
ALTER TABLE "PlannedMeal" ADD COLUMN "pantryMoves" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "DiaryEntry" ADD COLUMN "pantryMoves" JSONB NOT NULL DEFAULT '[]';
