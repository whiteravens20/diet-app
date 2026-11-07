-- The real expenditure of a profile, worked out from its diary and weights: a correction it accepted and the last working out.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "expenditureCheckedOn" DATE,
ADD COLUMN     "expenditureCorrectionKcal" INTEGER,
ADD COLUMN     "expenditureDays" INTEGER,
ADD COLUMN     "expenditureEstimateKcal" INTEGER,
ADD COLUMN     "expenditureLaterUntil" DATE,
ADD COLUMN     "expenditureWeights" INTEGER;

