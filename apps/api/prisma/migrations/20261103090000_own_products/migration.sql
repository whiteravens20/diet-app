-- Products of an account's own, and those the instance accepted of them.
-- AlterEnum
ALTER TYPE "ProductOrigin" ADD VALUE 'accepted';

-- CreateEnum
CREATE TYPE "OwnProductState" AS ENUM ('own', 'sent', 'rejected');

-- CreateEnum
CREATE TYPE "OwnProductChangeKind" AS ENUM ('written', 'sent');

-- AlterTable
ALTER TABLE "DiaryEntry" ADD COLUMN     "ownProductId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedBy" TEXT,
ADD COLUMN     "authorId" TEXT;

-- CreateTable
CREATE TABLE "OwnProduct" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "searchText" TEXT NOT NULL,
    "pack" TEXT,
    "unit" "Unit" NOT NULL,
    "packAmount" DOUBLE PRECISION,
    "servingAmount" DOUBLE PRECISION,
    "calories" DOUBLE PRECISION NOT NULL,
    "protein" DOUBLE PRECISION,
    "fat" DOUBLE PRECISION,
    "carbs" DOUBLE PRECISION,
    "fiber" DOUBLE PRECISION,
    "sugars" DOUBLE PRECISION,
    "salt" DOUBLE PRECISION,
    "saturatedFat" DOUBLE PRECISION,
    "doubtful" BOOLEAN NOT NULL DEFAULT false,
    "state" "OwnProductState" NOT NULL DEFAULT 'own',
    "sentAt" TIMESTAMP(3),
    "reason" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnProductChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "OwnProductChangeKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnProductChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnProduct_code_idx" ON "OwnProduct"("code");

-- CreateIndex
CREATE INDEX "OwnProduct_state_sentAt_idx" ON "OwnProduct"("state", "sentAt");

-- CreateIndex
CREATE INDEX "OwnProduct_checkedAt_idx" ON "OwnProduct"("checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OwnProduct_userId_code_key" ON "OwnProduct"("userId", "code");

-- CreateIndex
CREATE INDEX "OwnProductChange_userId_kind_at_idx" ON "OwnProductChange"("userId", "kind", "at");

-- CreateIndex
CREATE INDEX "DiaryEntry_ownProductId_idx" ON "DiaryEntry"("ownProductId");

-- CreateIndex
CREATE INDEX "Product_authorId_idx" ON "Product"("authorId");

-- AddForeignKey
ALTER TABLE "DiaryEntry" ADD CONSTRAINT "DiaryEntry_ownProductId_fkey" FOREIGN KEY ("ownProductId") REFERENCES "OwnProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnProduct" ADD CONSTRAINT "OwnProduct_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnProductChange" ADD CONSTRAINT "OwnProductChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
