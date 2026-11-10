-- Two plans of profiles of one account made together, and the meals they share at the times of day both have.
-- AlterTable
ALTER TABLE "MealPlan" ADD COLUMN     "jointPlanId" TEXT;

-- AlterTable
ALTER TABLE "PlannedMeal" ADD COLUMN     "sharedMealId" TEXT;

-- CreateTable
CREATE TABLE "JointPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JointPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedMeal" (
    "id" TEXT NOT NULL,
    "jointPlanId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "mealType" TEXT NOT NULL,
    "apart" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SharedMeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JointPlan_userId_idx" ON "JointPlan"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedMeal_jointPlanId_date_mealType_key" ON "SharedMeal"("jointPlanId", "date", "mealType");

-- CreateIndex
CREATE INDEX "MealPlan_jointPlanId_idx" ON "MealPlan"("jointPlanId");

-- CreateIndex
CREATE INDEX "PlannedMeal_sharedMealId_idx" ON "PlannedMeal"("sharedMealId");

-- AddForeignKey
ALTER TABLE "MealPlan" ADD CONSTRAINT "MealPlan_jointPlanId_fkey" FOREIGN KEY ("jointPlanId") REFERENCES "JointPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JointPlan" ADD CONSTRAINT "JointPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedMeal" ADD CONSTRAINT "SharedMeal_jointPlanId_fkey" FOREIGN KEY ("jointPlanId") REFERENCES "JointPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedMeal" ADD CONSTRAINT "PlannedMeal_sharedMealId_fkey" FOREIGN KEY ("sharedMealId") REFERENCES "SharedMeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

