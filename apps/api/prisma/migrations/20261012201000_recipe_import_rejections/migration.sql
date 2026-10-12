-- A recipe an import did not take, with every reason: for the administrator
-- to look through. It was never a draft.
CREATE TABLE "RecipeImportRejection" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "reasons" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeImportRejection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecipeImportRejection_createdAt_idx" ON "RecipeImportRejection"("createdAt");
CREATE INDEX "RecipeImportRejection_batchId_idx" ON "RecipeImportRejection"("batchId");
