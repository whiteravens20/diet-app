-- Eggs and tortillas are taken in whole pieces. A meal eaten before that keeps what it was planned with.
ALTER TABLE "PlannedMeal" ADD COLUMN     "wholePieces" BOOLEAN NOT NULL DEFAULT true;
UPDATE "PlannedMeal" SET "wholePieces" = false WHERE "eatenAt" IS NOT NULL;
