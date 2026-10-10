-- An ingredient that is counted instead of weighed says what one piece of it
-- is called. Its weight stays in "gramsPerPiece". Filled by the catalogue
-- update from the curated data.
CREATE TYPE "NaturalUnit" AS ENUM ('piece', 'slice', 'clove', 'handful');
ALTER TABLE "Ingredient" ADD COLUMN "displayUnit" "NaturalUnit";
