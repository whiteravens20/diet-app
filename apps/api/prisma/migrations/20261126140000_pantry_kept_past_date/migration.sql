-- Fresh stock said to be still good past its best-before day ("Nadal dobre"), which counts at home again.
ALTER TABLE "InventoryItem" ADD COLUMN "keptPastDate" BOOLEAN NOT NULL DEFAULT false;
