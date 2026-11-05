-- The limits of fibre, sugars, salt and saturated fat a profile sets, in grams a day.
-- AlterTable
ALTER TABLE "ProfilePreference" ADD COLUMN     "fiberAtLeast" DOUBLE PRECISION,
ADD COLUMN     "saltAtMost" DOUBLE PRECISION,
ADD COLUMN     "saturatedFatAtMost" DOUBLE PRECISION,
ADD COLUMN     "sugarsAtMost" DOUBLE PRECISION;
