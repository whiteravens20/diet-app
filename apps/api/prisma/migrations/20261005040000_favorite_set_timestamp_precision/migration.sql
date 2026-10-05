-- FavoriteSet was created with TIMESTAMP columns (microseconds). schema.prisma
-- and every other table use TIMESTAMP(3), so the two had drifted apart.

-- AlterTable
ALTER TABLE "FavoriteSet" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);
