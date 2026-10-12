-- An ingredient that is bought a pack at a time may be one whose opened pack
-- does not keep: what a plan leaves of such a pack is counted as waste. The
-- catalogue update sets it from the data; until then no ingredient is.
ALTER TABLE "Ingredient" ADD COLUMN "perishable" BOOLEAN NOT NULL DEFAULT false;
