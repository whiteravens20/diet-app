-- A recipe that shipped from the curation queue into an instance's own library
-- is `curated`, whoever wrote it; `ai` names a personal recipe a model wrote.
-- Recipes shipped before this rule carry `ai` and belong to nobody.
UPDATE "Recipe" SET "origin" = 'curated' WHERE "origin" = 'ai' AND "createdByUserId" IS NULL;
