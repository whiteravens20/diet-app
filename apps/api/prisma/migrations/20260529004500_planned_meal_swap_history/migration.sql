-- Track recipes already shown for a slot via "swap meal" so repeated swaps
-- advance instead of cycling between two candidates.
ALTER TABLE "PlannedMeal" ADD COLUMN "swapHistory" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
