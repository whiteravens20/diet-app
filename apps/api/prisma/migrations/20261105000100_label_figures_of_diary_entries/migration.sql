-- Which of a diary entry's fibre, sugars, salt and saturated fat are only a part of what it holds.
-- AlterTable
ALTER TABLE "DiaryEntry" ADD COLUMN     "labelAtLeast" TEXT[] DEFAULT ARRAY[]::TEXT[];
