-- CreateTable
CREATE TABLE "ProfileTarget" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "from" DATE NOT NULL,
    "target" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayTarget" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "target" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DayTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileTarget_profileId_from_key" ON "ProfileTarget"("profileId", "from");

-- CreateIndex
CREATE UNIQUE INDEX "DayTarget_profileId_date_key" ON "DayTarget"("profileId", "date");

-- AddForeignKey
ALTER TABLE "ProfileTarget" ADD CONSTRAINT "ProfileTarget_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayTarget" ADD CONSTRAINT "DayTarget_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
