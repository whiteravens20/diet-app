-- What a search of the products reads with: a search by a part of a word, in an index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "ProductOrigin" AS ENUM ('imported', 'looked_up');

-- AlterEnum
ALTER TYPE "DiaryEntryKind" ADD VALUE 'product';

-- AlterTable
ALTER TABLE "DiaryEntry" ADD COLUMN     "fiber" DOUBLE PRECISION,
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "salt" DOUBLE PRECISION,
ADD COLUMN     "saturatedFat" DOUBLE PRECISION,
ADD COLUMN     "sugars" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "searchText" TEXT NOT NULL,
    "pack" TEXT,
    "unit" "Unit" NOT NULL,
    "packAmount" DOUBLE PRECISION,
    "servingAmount" DOUBLE PRECISION,
    "calories" DOUBLE PRECISION,
    "protein" DOUBLE PRECISION,
    "fat" DOUBLE PRECISION,
    "carbs" DOUBLE PRECISION,
    "fiber" DOUBLE PRECISION,
    "sugars" DOUBLE PRECISION,
    "salt" DOUBLE PRECISION,
    "saturatedFat" DOUBLE PRECISION,
    "energyWorkedOut" BOOLEAN NOT NULL DEFAULT false,
    "doubtful" BOOLEAN NOT NULL DEFAULT false,
    "origin" "ProductOrigin" NOT NULL,
    "changedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "popularity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCodeUnknown" (
    "code" TEXT NOT NULL,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCodeUnknown_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ProductLookup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductLookup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_code_key" ON "Product"("code");

-- CreateIndex
CREATE INDEX "Product_searchText_idx" ON "Product" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Product_origin_idx" ON "Product"("origin");

-- CreateIndex
CREATE INDEX "ProductCodeUnknown_askedAt_idx" ON "ProductCodeUnknown"("askedAt");

-- CreateIndex
CREATE INDEX "ProductLookup_userId_at_idx" ON "ProductLookup"("userId", "at");

-- CreateIndex
CREATE INDEX "ProductLookup_at_idx" ON "ProductLookup"("at");

-- CreateIndex
CREATE INDEX "DiaryEntry_productId_idx" ON "DiaryEntry"("productId");

-- AddForeignKey
ALTER TABLE "DiaryEntry" ADD CONSTRAINT "DiaryEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLookup" ADD CONSTRAINT "ProductLookup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

