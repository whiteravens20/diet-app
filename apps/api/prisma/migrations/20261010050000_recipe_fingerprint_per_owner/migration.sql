-- A recipe's fingerprint was unique across all recipes, so the second user to
-- make the same ingredient swap, or to get the same recipe from a model, hit
-- the index and got a server error. It is now unique per owner: two users may
-- each own the same recipe, one user owns it once.
DROP INDEX "Recipe_fingerprint_key";

-- The fingerprint also changed its form (the lines as they are written, no
-- diet tags), so no stored value can match a new one. They are cleared here
-- and written again by the catalogue update and by every later save.
UPDATE "Recipe" SET "fingerprint" = NULL WHERE "fingerprint" IS NOT NULL;
UPDATE "RecipeDraft" SET "fingerprint" = NULL WHERE "fingerprint" IS NOT NULL;

CREATE UNIQUE INDEX "Recipe_createdByUserId_fingerprint_key" ON "Recipe"("createdByUserId", "fingerprint");
CREATE INDEX "Recipe_fingerprint_idx" ON "Recipe"("fingerprint");

-- A draft made from personal recipes named the user who first made one, in a
-- column of its own and as a prefix of its batch name, which reviewers see.
-- Nothing needs either: the draft points at the recipes it stands for.
ALTER TABLE "RecipeDraft" DROP COLUMN "createdByUserId";
UPDATE "RecipeDraft" SET "batchId" = 'personal-recipes' WHERE "source" = 'AI_USER';
