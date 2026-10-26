-- Drafts are no longer shipped as pull requests: the address of one is not kept.
ALTER TABLE "RecipeDraft" DROP COLUMN "shippedPRUrl";

ALTER TABLE "IngredientNameDraft" DROP COLUMN "shippedPRUrl";
