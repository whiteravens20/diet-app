-- The order of a recipe's ingredient lines, kept from now on. The lines that
-- are there take the order the table holds them in, which is the order they
-- were written in.
ALTER TABLE "RecipeIngredient" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

UPDATE "RecipeIngredient" line
SET "position" = ordered.place
FROM (
  SELECT id, (ROW_NUMBER() OVER (PARTITION BY "recipeId" ORDER BY ctid) - 1)::INTEGER AS place
  FROM "RecipeIngredient"
) ordered
WHERE line.id = ordered.id;
