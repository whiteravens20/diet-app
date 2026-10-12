-- The cuisine a draft was asked for, or was given by whoever curates it: the
-- recipe it ships as carries it.
ALTER TABLE "RecipeDraft" ADD COLUMN "cuisine" TEXT;
