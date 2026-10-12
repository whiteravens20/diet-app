-- Where a recipe that was taken in from somewhere else is from, and the
-- licence it may be passed on under. Null for a recipe written here.
ALTER TABLE "Recipe" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Recipe" ADD COLUMN "sourceLicense" TEXT;
