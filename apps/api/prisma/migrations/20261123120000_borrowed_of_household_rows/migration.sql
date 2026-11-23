-- What a part of a household list counted in the pantries of the household's other profiles.
ALTER TABLE "ShoppingListItem" ADD COLUMN "borrowed" JSONB NOT NULL DEFAULT '[]';
