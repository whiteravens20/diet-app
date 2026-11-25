-- CreateTable
CREATE TABLE "PlanDayEvent" (
    "id" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cause" TEXT NOT NULL,
    "own" BOOLEAN NOT NULL,
    "detail" JSONB,
    "changes" JSONB NOT NULL,
    "effects" JSONB,
    "revision" INTEGER NOT NULL,

    CONSTRAINT "PlanDayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanDayEvent_dayId_revision_idx" ON "PlanDayEvent"("dayId", "revision");

-- CreateIndex
CREATE INDEX "PlanDayEvent_change_idx" ON "PlanDayEvent"("change");

-- AddForeignKey
ALTER TABLE "PlanDayEvent" ADD CONSTRAINT "PlanDayEvent_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "MealPlanDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
