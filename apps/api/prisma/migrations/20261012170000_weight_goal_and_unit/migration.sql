-- The weight a profile is working towards, and the unit an account reads and
-- types a body weight in. Both are empty until somebody says them.
ALTER TABLE "Profile" ADD COLUMN "targetWeightKg" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN "weightUnit" TEXT;
