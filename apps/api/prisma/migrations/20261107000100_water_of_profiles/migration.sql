-- The water a profile drinks: the target of its day and what it drank, a glass at a time.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "waterTargetMl" INTEGER DEFAULT 2000;

-- CreateTable
CREATE TABLE "WaterEntry" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "ml" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaterEntry_profileId_day_idx" ON "WaterEntry"("profileId", "day");

-- AddForeignKey
ALTER TABLE "WaterEntry" ADD CONSTRAINT "WaterEntry_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

