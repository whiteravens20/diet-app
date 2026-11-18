-- Every freezing is a package of its own: a frozen row is told from another of the same food and unit by its number,
-- the next of its profile's (`Profile.lastParcel`), never used again. What is fresh is package 0, one row a food and
-- unit as before; a frozen row from before packages is package 0 too.
ALTER TABLE "Profile" ADD COLUMN "lastParcel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InventoryItem" ADD COLUMN "parcel" INTEGER NOT NULL DEFAULT 0;
DROP INDEX "InventoryItem_profileId_ingredientId_unit_frozen_key";
CREATE UNIQUE INDEX "InventoryItem_profileId_ingredientId_unit_frozen_parcel_key" ON "InventoryItem"("profileId", "ingredientId", "unit", "frozen", "parcel");
