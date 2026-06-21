-- F17 Advanced meal-plan options.
--
-- Two additive, nullable columns — existing rows keep NULL, which the engine
-- and service treat as "no advanced options" (identical to pre-F17 behaviour).
--
-- MealPlanDay.overrides holds the raw per-day advanced inputs + semantics:
--   { mealCount?, dayType?, skip?, cookTimeBudgetMinutes?, useUpBy?, lockedSlots? }
-- The *resolved* per-day calorie target still lands in the existing
-- MealPlanDay.calorieTarget column, so the swap path, favorite-set apply, and
-- the future F22 rebalancer read it unchanged.
--
-- MealPlan.maxRepeatsPerRecipe is the plan-wide variety floor, persisted so
-- `regenerate` re-applies the same cap.

ALTER TABLE "MealPlan" ADD COLUMN "maxRepeatsPerRecipe" INTEGER;

ALTER TABLE "MealPlanDay" ADD COLUMN "overrides" JSONB;
