-- A review of a draft now says who wrote it, and is kept when a later review
-- or an edit takes its place: it is marked superseded instead of being
-- deleted. The review a language has now is the row whose "supersededAt" is
-- null. That there is one such row per draft and language is no longer kept
-- by a unique index, which a kept history rules out, but by the lock every
-- writer takes on the draft.

-- CreateEnum
CREATE TYPE "ReviewerRole" AS ENUM ('ADMIN', 'REVIEWER');

-- DropIndex
DROP INDEX "IngredientNameDraftLocaleReview_draftId_idx";

-- DropIndex
DROP INDEX "IngredientNameDraftLocaleReview_draftId_locale_key";

-- DropIndex
DROP INDEX "RecipeDraftLocaleReview_draftId_idx";

-- DropIndex
DROP INDEX "RecipeDraftLocaleReview_draftId_locale_key";

-- AlterTable
ALTER TABLE "IngredientNameDraftLocaleReview" ADD COLUMN     "byRole" "ReviewerRole",
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RecipeDraftLocaleReview" ADD COLUMN     "byRole" "ReviewerRole",
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "IngredientNameDraftLocaleReview_draftId_locale_idx" ON "IngredientNameDraftLocaleReview"("draftId", "locale");

-- CreateIndex
CREATE INDEX "RecipeDraftLocaleReview_draftId_locale_idx" ON "RecipeDraftLocaleReview"("draftId", "locale");

-- Only the administrator can review English: the reviewers' routes refuse it.
-- Who wrote the reviews of the other languages before this is not known, and
-- those rows keep no role.
UPDATE "RecipeDraftLocaleReview" SET "byRole" = 'ADMIN' WHERE "locale" = 'en';
