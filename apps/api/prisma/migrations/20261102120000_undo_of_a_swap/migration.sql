-- What the last swap of a plan changed, so that it can be taken back.
ALTER TABLE "MealPlan" ADD COLUMN "lastSwap" JSONB;
