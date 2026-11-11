-- What was left of a meal, eaten the next day in the place of a dish planned.
-- AlterTable
ALTER TABLE "PlannedMeal" ADD COLUMN     "carriedToMealType" TEXT,
ADD COLUMN     "givenLeftoverId" TEXT,
ADD COLUMN     "leftoverFromDate" DATE,
ADD COLUMN     "leftoverFromMealType" TEXT,
ADD COLUMN     "leftoverUndo" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "PlannedMeal_givenLeftoverId_key" ON "PlannedMeal"("givenLeftoverId");

-- AddForeignKey
ALTER TABLE "PlannedMeal" ADD CONSTRAINT "PlannedMeal_givenLeftoverId_fkey" FOREIGN KEY ("givenLeftoverId") REFERENCES "PlannedMeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
