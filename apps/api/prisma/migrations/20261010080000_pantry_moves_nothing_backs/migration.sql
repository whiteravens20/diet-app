-- A row ticked before shopping rows kept their moves stored one number: the
-- change it meant to make to the pantry, in its own unit. The pantry was
-- changed only where it held a row of that ingredient in that unit; where the
-- stock was in another unit (six eggs counted in pieces, the row in grams)
-- nothing was taken, and the number was stored all the same. The previous
-- migration turned every such number into a move.
--
-- A move nothing backs is dropped here: the row of a list made before that
-- migration, whose one move takes from a unit the profile holds no pantry row
-- in. Unticking such a row, or replacing its list, then puts nothing into the
-- pantry that was never taken out of it. Where the old code did empty the row
-- it took from, the move is dropped as well and the stock has to be entered
-- again by hand: a list that asks to buy what is at home is the lesser error.
UPDATE "ShoppingListItem" item
   SET "pantryMoves" = '[]'
  FROM "ShoppingList" list
  JOIN "MealPlan" plan ON plan."id" = list."planId"
 WHERE list."id" = item."listId"
   AND list."createdAt" < (
         SELECT max("finished_at") AT TIME ZONE 'UTC'
           FROM "_prisma_migrations"
          WHERE "migration_name" = '20261010070000_shopping_pantry_moves'
       )
   AND jsonb_array_length(item."pantryMoves") = 1
   AND item."pantryMoves" -> 0 ->> 'unit' = item."unit"::text
   AND (item."pantryMoves" -> 0 ->> 'quantity')::double precision < 0
   AND NOT EXISTS (
         SELECT 1
           FROM "InventoryItem" stock
          WHERE stock."profileId" = plan."profileId"
            AND stock."ingredientId" = item."ingredientId"
            AND stock."unit" = item."unit"
       );
