-- F15.1 inventory follow-ups: shopping list ↔ pantry consumption / over-buy
-- auto-flow + anti-monotony rotation.
--
-- ShoppingListItem.purchasedQuantity (nullable) is what the user actually bought
-- for this line; null until they fill it. inventoryDelta is the signed pantry
-- change applied on check-off (`purchased - total`): negative when the plan
-- committed the pantry portion, positive when an over-buy left a leftover, zero
-- when the row is unchecked. Stored so uncheck reverses the exact amount we
-- applied — idempotent across any number of check/uncheck cycles.
--
-- Profile.inventoryBiasStreak + ProfilePreference.inventoryBiasResetEvery are
-- the anti-monotony counter + threshold. The optimiser bumps the streak each
-- time it actually applied a pantry bias; when it reaches the threshold it
-- drops the bias for the next round and resets the counter. 0 disables the
-- reset entirely.

ALTER TABLE "ShoppingListItem"
  ADD COLUMN "purchasedQuantity" DOUBLE PRECISION,
  ADD COLUMN "inventoryDelta" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "Profile"
  ADD COLUMN "inventoryBiasStreak" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ProfilePreference"
  ADD COLUMN "inventoryBiasResetEvery" INTEGER NOT NULL DEFAULT 5;
