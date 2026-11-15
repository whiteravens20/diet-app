-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "frozen" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex
DROP INDEX "InventoryItem_profileId_ingredientId_unit_key";

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_profileId_ingredientId_unit_frozen_key" ON "InventoryItem"("profileId", "ingredientId", "unit", "frozen");
