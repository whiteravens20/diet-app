-- A profile's reminder, the evening before, of what it cooks ahead the next day.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "cookingReminders" BOOLEAN NOT NULL DEFAULT true;
