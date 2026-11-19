-- AlterTable
ALTER TABLE "DiaryEntry" ADD COLUMN     "estimatedMacros" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- A meal of its own written before held whether something was estimated, not what: all of it was.
UPDATE "DiaryEntry" SET "estimatedMacros" = ARRAY['protein', 'fat', 'carbs'] WHERE "kind" = 'meal' AND "estimated";
