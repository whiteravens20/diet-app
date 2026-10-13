-- Deleting a row makes the database look for the rows that point at it. Four
-- columns that point at a recipe or an ingredient had no index that begins
-- with them, so each such look read their whole table.
CREATE INDEX "Favorite_recipeId_idx" ON "Favorite"("recipeId");
CREATE INDEX "InventoryItem_ingredientId_idx" ON "InventoryItem"("ingredientId");
CREATE INDEX "SubstitutionRule_toIngredientId_idx" ON "SubstitutionRule"("toIngredientId");
CREATE INDEX "IngredientNameDraft_ingredientId_idx" ON "IngredientNameDraft"("ingredientId");

-- An index that holds only the first columns of another index of its table
-- answers nothing the other does not, and is written at every change.
DROP INDEX "Favorite_profileId_idx";
DROP INDEX "InventoryItem_profileId_idx";
DROP INDEX "InventoryItem_profileId_ingredientId_idx";
DROP INDEX "AiUsageLog_userId_idx";
