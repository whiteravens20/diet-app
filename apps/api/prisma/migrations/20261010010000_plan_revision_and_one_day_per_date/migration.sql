-- A plan has one day per date. Two overlapping regenerations could leave a date
-- twice, so keep one row per (plan, date) before the constraint goes in: the
-- row with the most eaten meals, and of equals the one with the lowest id.
-- The meals of a removed day go with it.
DELETE FROM "MealPlanDay" AS day
USING (
  SELECT
    d."id",
    ROW_NUMBER() OVER (
      PARTITION BY d."planId", d."date"
      ORDER BY (
        SELECT COUNT(*) FROM "PlannedMeal" m WHERE m."dayId" = d."id" AND m."eatenAt" IS NOT NULL
      ) DESC, d."id" ASC
    ) AS position
  FROM "MealPlanDay" d
) AS ranked
WHERE day."id" = ranked."id" AND ranked.position > 1;

-- DropIndex
DROP INDEX "MealPlanDay_planId_idx";

-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "MealPlanDay_planId_date_key" ON "MealPlanDay"("planId", "date");
