-- The diary of a profile: what it ate on a day besides the meals its plan
-- marks as eaten, each entry with the figures worked out when it was written.
CREATE TYPE "DiaryEntryKind" AS ENUM ('recipe', 'ingredient', 'meal');

CREATE TABLE "DiaryEntry" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "mealType" TEXT NOT NULL,
    "kind" "DiaryEntryKind" NOT NULL,
    "recipeId" TEXT,
    "ingredientId" TEXT,
    "name" TEXT NOT NULL,
    "servings" DOUBLE PRECISION,
    "quantity" DOUBLE PRECISION,
    "unit" "Unit",
    "calories" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION NOT NULL,
    "fat" DOUBLE PRECISION NOT NULL,
    "carbs" DOUBLE PRECISION NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiaryEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiaryEntry_profileId_date_idx" ON "DiaryEntry"("profileId", "date");

CREATE INDEX "DiaryEntry_recipeId_idx" ON "DiaryEntry"("recipeId");

CREATE INDEX "DiaryEntry_ingredientId_idx" ON "DiaryEntry"("ingredientId");

ALTER TABLE "DiaryEntry" ADD CONSTRAINT "DiaryEntry_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiaryEntry" ADD CONSTRAINT "DiaryEntry_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DiaryEntry" ADD CONSTRAINT "DiaryEntry_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
