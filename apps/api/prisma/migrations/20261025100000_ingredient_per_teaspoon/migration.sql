-- How much of an ingredient a level teaspoon holds, in its canonical unit:
-- small quantities of it are shown in teaspoons and pinches.
ALTER TABLE "Ingredient" ADD COLUMN "perTeaspoon" DOUBLE PRECISION;
