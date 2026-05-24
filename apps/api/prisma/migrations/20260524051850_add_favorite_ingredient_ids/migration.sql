-- Per-profile ingredient favourites — a soft bias for the optimiser, mirroring
-- the existing excludedIngredientIds hard filter.
ALTER TABLE "ProfilePreference"
ADD COLUMN "favoriteIngredientIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
