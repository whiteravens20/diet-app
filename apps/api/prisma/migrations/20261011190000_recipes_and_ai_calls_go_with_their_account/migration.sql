-- A personal recipe and the record of an AI call belong to an account and go
-- with it. Until now a deleted account left its recipes behind with its id on
-- them, and its calls with no id.

-- What the calls of deleted accounts count for in the instance's monthly
-- allowance, by day, without the account.
CREATE TABLE "AiUsageOfDeletedAccounts" (
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL,

    CONSTRAINT "AiUsageOfDeletedAccounts_pkey" PRIMARY KEY ("day")
);

-- The calls accounts deleted before today left behind: those that still count
-- are kept by day, and the rows go.
INSERT INTO "AiUsageOfDeletedAccounts" ("day", "calls")
SELECT "createdAt"::date, COUNT(*)
FROM "AiUsageLog"
WHERE "userId" IS NULL AND "mode" = 'admin' AND "outcome" = 'COMPLETED' AND "createdAt" >= NOW() - INTERVAL '30 days'
GROUP BY 1;

DELETE FROM "AiUsageLog" WHERE "userId" IS NULL;

ALTER TABLE "AiUsageLog" DROP CONSTRAINT "AiUsageLog_userId_fkey";
ALTER TABLE "AiUsageLog" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The personal recipes of accounts that are gone. Nobody can reach them: a
-- personal recipe is shown to its owner alone.
CREATE TEMPORARY TABLE "_orphan_recipe" AS
SELECT r."id" FROM "Recipe" r
WHERE r."createdByUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = r."createdByUserId");

-- A draft of the curation queue keeps no pointer to a recipe that goes. One
-- that stood for such recipes alone, and has not shipped, goes with them.
CREATE TEMPORARY TABLE "_orphan_draft" AS
SELECT d."id" FROM "RecipeDraft" d
WHERE d."sourceRecipeIds" && ARRAY(SELECT "id" FROM "_orphan_recipe");

UPDATE "RecipeDraft" d
SET "sourceRecipeIds" = ARRAY(SELECT source FROM unnest(d."sourceRecipeIds") AS source WHERE source NOT IN (SELECT "id" FROM "_orphan_recipe"))
WHERE d."id" IN (SELECT "id" FROM "_orphan_draft");

DELETE FROM "RecipeDraft" d
WHERE d."id" IN (SELECT "id" FROM "_orphan_draft") AND d."status" <> 'SHIPPED' AND cardinality(d."sourceRecipeIds") = 0;

-- Where a plan of another account still holds such a recipe, which no rule
-- has allowed since plans were given a gate, the recipe stays for that plan
-- alone: without an owner, deleted and retired, so that nothing else shows it.
UPDATE "Recipe" r
SET "createdByUserId" = NULL, "deletedAt" = COALESCE(r."deletedAt", NOW()), "retiredAt" = COALESCE(r."retiredAt", NOW())
WHERE r."id" IN (SELECT "id" FROM "_orphan_recipe") AND EXISTS (SELECT 1 FROM "PlannedMeal" m WHERE m."recipeId" = r."id");

DELETE FROM "Recipe" r
WHERE r."id" IN (SELECT "id" FROM "_orphan_recipe") AND r."createdByUserId" IS NOT NULL;

DROP TABLE "_orphan_draft";
DROP TABLE "_orphan_recipe";

ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
