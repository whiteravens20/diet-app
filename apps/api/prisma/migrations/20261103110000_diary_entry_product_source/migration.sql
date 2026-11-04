-- Where the figures of a diary entry of a product came from when it was written.
CREATE TYPE "ProductSource" AS ENUM ('open_food_facts', 'instance', 'own');

ALTER TABLE "DiaryEntry" ADD COLUMN "productSource" "ProductSource";

UPDATE "DiaryEntry"
SET "productSource" = CASE WHEN "ownProductId" IS NULL THEN 'open_food_facts'::"ProductSource" ELSE 'own'::"ProductSource" END
WHERE "kind" = 'product';
