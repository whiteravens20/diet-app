-- CreateEnum
CREATE TYPE "TranslationSource" AS ENUM ('CURATED_JSON', 'AI', 'MANUAL');

-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "theme" TEXT NOT NULL DEFAULT 'system';

-- CreateTable
CREATE TABLE "IngredientTranslation" (
    "ingredientId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageHint" TEXT,
    "source" "TranslationSource" NOT NULL DEFAULT 'CURATED_JSON',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientTranslation_pkey" PRIMARY KEY ("ingredientId","locale")
);

-- CreateTable
CREATE TABLE "RecipeTranslation" (
    "recipeId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "steps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "TranslationSource" NOT NULL DEFAULT 'CURATED_JSON',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeTranslation_pkey" PRIMARY KEY ("recipeId","locale")
);

-- CreateIndex
CREATE INDEX "IngredientTranslation_locale_idx" ON "IngredientTranslation"("locale");

-- CreateIndex
CREATE INDEX "IngredientTranslation_source_idx" ON "IngredientTranslation"("source");

-- CreateIndex
CREATE INDEX "RecipeTranslation_locale_idx" ON "RecipeTranslation"("locale");

-- CreateIndex
CREATE INDEX "RecipeTranslation_source_idx" ON "RecipeTranslation"("source");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_slug_key" ON "Ingredient"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_slug_key" ON "Recipe"("slug");

-- AddForeignKey
ALTER TABLE "IngredientTranslation" ADD CONSTRAINT "IngredientTranslation_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeTranslation" ADD CONSTRAINT "RecipeTranslation_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

