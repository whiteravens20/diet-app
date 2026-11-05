-- Fibre, sugars, salt and saturated fat: an ingredient's in 100 units, and a recipe's of a serving.
-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "fiberPer100" DOUBLE PRECISION,
ADD COLUMN     "saltPer100" DOUBLE PRECISION,
ADD COLUMN     "saturatedFatPer100" DOUBLE PRECISION,
ADD COLUMN     "sugarsPer100" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "labelPerServing" JSONB;
