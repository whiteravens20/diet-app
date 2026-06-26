-- Index PlannedMeal.recipeId.
--
-- Reads that go plan -> day -> meal are already covered by the dayId index, but
-- any "which planned meals reference recipe X" lookup (recipe delete/cascade
-- checks, future cross-plan reporting) would otherwise sequentially scan the
-- whole PlannedMeal table. Additive; no data change.

-- CreateIndex
CREATE INDEX "PlannedMeal_recipeId_idx" ON "PlannedMeal"("recipeId");
