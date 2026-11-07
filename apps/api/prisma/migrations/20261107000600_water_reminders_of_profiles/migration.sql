-- A profile's reminders to drink while its day is behind its target, and when the last one came.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "lastWaterReminderAt" TIMESTAMP(3),
ADD COLUMN     "waterReminders" BOOLEAN NOT NULL DEFAULT false;
