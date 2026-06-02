-- F15.1 follow-up: snapshot the earliest pantry best-before on the shopping
-- row at list-creation time, so the "from pantry" chip can surface urgency
-- while the user shops. Nullable: no pantry contribution or no recorded
-- expiry → null and the UI just shows the plain chip.

ALTER TABLE "ShoppingListItem"
  ADD COLUMN "pantryBestBefore" TIMESTAMP(3);
