-- The day what was bought for a row of a shopping list was bought by weight rather than in packs: its plan counts the
-- food from that day, and says what to freeze of it. Null for every row there is: bought in packs, or not yet.
ALTER TABLE "ShoppingListItem" ADD COLUMN "boughtLooseOn" DATE;
