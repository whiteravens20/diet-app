-- When a person last changed what the model wrote: a run for every unapproved
-- name leaves such a draft alone.
ALTER TABLE "IngredientNameDraft" ADD COLUMN "editedAt" TIMESTAMP(3);

-- Nothing recorded this until now. A draft that waits and was changed after it
-- was written may have been edited, so it counts as edited: at worst the bulk
-- run leaves it, and its own row can still write it anew.
UPDATE "IngredientNameDraft"
SET "editedAt" = "updatedAt"
WHERE "status" = 'PENDING' AND "updatedAt" > "createdAt" + INTERVAL '1 second';
