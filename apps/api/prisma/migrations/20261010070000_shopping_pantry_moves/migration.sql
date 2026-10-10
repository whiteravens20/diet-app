-- A shopping row used to keep one number: the change it meant to make to the
-- pantry, in its own unit, whether or not the pantry held that much. It now
-- keeps the moves it made, one per pantry row. A number that was stored
-- becomes one move in the row's unit, which is what it claimed to be.
ALTER TABLE "ShoppingListItem" ADD COLUMN "pantryMoves" JSONB NOT NULL DEFAULT '[]';
UPDATE "ShoppingListItem"
   SET "pantryMoves" = jsonb_build_array(jsonb_build_object('unit', "unit"::text, 'quantity', "inventoryDelta"))
 WHERE "inventoryDelta" <> 0;
ALTER TABLE "ShoppingListItem" DROP COLUMN "inventoryDelta";
