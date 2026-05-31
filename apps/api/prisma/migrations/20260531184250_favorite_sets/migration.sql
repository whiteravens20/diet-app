-- Per-profile saved "day template" — one favourited recipe per meal slot, named
-- by the user (e.g. "Set 1" = breakfast + lunch + dinner). Composable from the
-- dashboard and applicable to one or more days of a plan in a single action.
--
-- slots: JSONB { [mealType: string]: recipeId: string }. Stored loose because
-- the optimiser already validates recipe references at apply-time; an FK array
-- would force a join table without buying integrity we don't already have.
CREATE TABLE "FavoriteSet" (
  "id"        TEXT      NOT NULL,
  "profileId" TEXT      NOT NULL,
  "label"     TEXT      NOT NULL,
  "slots"     JSONB     NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL,
  CONSTRAINT "FavoriteSet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FavoriteSet_profileId_idx" ON "FavoriteSet"("profileId");

ALTER TABLE "FavoriteSet"
  ADD CONSTRAINT "FavoriteSet_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
