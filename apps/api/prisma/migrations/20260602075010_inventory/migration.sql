-- F15: per-profile pantry-aware planning.
--
-- New `InventoryItem` table holds the stock each profile actually owns
-- (manually managed via the /inventory page). The optimiser reads it to
-- bias plan generation and the swap candidate pools toward recipes / sub-
-- ingredients the inventory can cover. See `engine/optimizer.ts` for the
-- coverage scoring factor.
--
-- Anti-monotony reset (per-profile counter + threshold) is parked for F15.1
-- and not part of this migration.

CREATE TABLE "InventoryItem" (
  "id"           TEXT NOT NULL,
  "profileId"    TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "quantity"     DOUBLE PRECISION NOT NULL,
  "unit"         "Unit" NOT NULL,
  "bestBefore"   DATE,
  "note"         TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- A profile can hold the same ingredient in multiple units (200 g chicken AND
-- 1 piece chicken-breast coexist). Adding more of the same ingredient at the
-- same unit aggregates into the existing row instead of creating duplicates.
CREATE UNIQUE INDEX "InventoryItem_profileId_ingredientId_unit_key"
  ON "InventoryItem"("profileId", "ingredientId", "unit");

CREATE INDEX "InventoryItem_profileId_idx" ON "InventoryItem"("profileId");

-- Hot path for the coverage lookup the optimiser runs per recipe candidate.
CREATE INDEX "InventoryItem_profileId_ingredientId_idx"
  ON "InventoryItem"("profileId", "ingredientId");

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_ingredientId_fkey"
  FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
