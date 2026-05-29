-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('AI', 'EXTERNAL', 'MANUAL');

-- CreateTable
CREATE TABLE "RecipeDraft" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "titles" JSONB NOT NULL,
    "descriptions" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "locales" TEXT[],
    "servings" INTEGER NOT NULL,
    "mealTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dietTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prepMinutes" INTEGER NOT NULL,
    "cookMinutes" INTEGER NOT NULL,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'easy',
    "complexity" TEXT NOT NULL DEFAULT 'medium',
    "caloriesPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "proteinPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fatPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "carbsPerServing" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ingredientsJson" JSONB NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "source" "DraftSource" NOT NULL DEFAULT 'AI',
    "batchId" TEXT NOT NULL,
    "modelUsed" TEXT,
    "generatorPrompt" TEXT,
    "generationSpec" JSONB,
    "provenanceUrl" TEXT,
    "provenanceLicense" TEXT,
    "shippedPRUrl" TEXT,
    "shippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeDraftLocaleReview" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reviewedByLabel" TEXT NOT NULL,
    "reason" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeDraftLocaleReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientNameDraft" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT,
    "ingredientSlug" TEXT NOT NULL,
    "rawDescription" TEXT NOT NULL,
    "suggestions" JSONB NOT NULL,
    "locales" TEXT[],
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "source" "DraftSource" NOT NULL DEFAULT 'AI',
    "batchId" TEXT NOT NULL,
    "modelUsed" TEXT,
    "generatorPrompt" TEXT,
    "shippedPRUrl" TEXT,
    "shippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientNameDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientNameDraftLocaleReview" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reviewedByLabel" TEXT NOT NULL,
    "reason" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngredientNameDraftLocaleReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "reviewerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reviewerPasswordHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipeDraft_status_idx" ON "RecipeDraft"("status");

-- CreateIndex
CREATE INDEX "RecipeDraft_batchId_idx" ON "RecipeDraft"("batchId");

-- CreateIndex
CREATE INDEX "RecipeDraft_source_idx" ON "RecipeDraft"("source");

-- CreateIndex
CREATE INDEX "RecipeDraftLocaleReview_draftId_idx" ON "RecipeDraftLocaleReview"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeDraftLocaleReview_draftId_locale_key" ON "RecipeDraftLocaleReview"("draftId", "locale");

-- CreateIndex
CREATE INDEX "IngredientNameDraft_status_idx" ON "IngredientNameDraft"("status");

-- CreateIndex
CREATE INDEX "IngredientNameDraft_batchId_idx" ON "IngredientNameDraft"("batchId");

-- CreateIndex
CREATE INDEX "IngredientNameDraft_ingredientSlug_idx" ON "IngredientNameDraft"("ingredientSlug");

-- CreateIndex
CREATE INDEX "IngredientNameDraftLocaleReview_draftId_idx" ON "IngredientNameDraftLocaleReview"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientNameDraftLocaleReview_draftId_locale_key" ON "IngredientNameDraftLocaleReview"("draftId", "locale");

-- AddForeignKey
ALTER TABLE "RecipeDraftLocaleReview" ADD CONSTRAINT "RecipeDraftLocaleReview_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "RecipeDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientNameDraft" ADD CONSTRAINT "IngredientNameDraft_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientNameDraftLocaleReview" ADD CONSTRAINT "IngredientNameDraftLocaleReview_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "IngredientNameDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
