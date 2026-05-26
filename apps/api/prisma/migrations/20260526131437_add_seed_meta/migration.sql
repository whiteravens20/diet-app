-- CreateTable
CREATE TABLE "SeedMeta" (
    "key" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "seededAt" TIMESTAMP(3) NOT NULL,
    "ingredients" INTEGER NOT NULL DEFAULT 0,
    "recipes" INTEGER NOT NULL DEFAULT 0,
    "substitutions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeedMeta_pkey" PRIMARY KEY ("key")
);
