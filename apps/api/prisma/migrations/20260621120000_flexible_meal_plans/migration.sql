-- F22 Flexible meal plans.
--
-- Edit-time layer on top of a generated plan: swap to any favourite, add a
-- user-authored custom meal, auto-rebalance quantities, mark meals eaten.
--
-- All additive except widening PlannedMeal.recipeId to nullable (custom meals
-- carry no catalogue recipe). Existing rows get source=CATALOGUE,
-- quantityScale=1.0 and NULL elsewhere — identical to pre-F22 behaviour.

-- CreateEnum
CREATE TYPE "PlannedMealSource" AS ENUM ('CATALOGUE', 'USER_CUSTOM');

-- Custom meals have no Recipe row.
ALTER TABLE "PlannedMeal" ALTER COLUMN "recipeId" DROP NOT NULL;

ALTER TABLE "PlannedMeal"
  ADD COLUMN "source" "PlannedMealSource" NOT NULL DEFAULT 'CATALOGUE',
  ADD COLUMN "customName" TEXT,
  ADD COLUMN "customMacros" JSONB,
  ADD COLUMN "eatenAt" TIMESTAMP(3),
  ADD COLUMN "quantityScale" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN "lastRebalanceAt" TIMESTAMP(3);
