-- A figure of a meal of one's own was estimated, as in the diary.
ALTER TABLE "PlannedMeal" ADD COLUMN "estimated" BOOLEAN NOT NULL DEFAULT false;
