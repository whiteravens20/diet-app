-- Whether a profile tracks water at all: on for every profile there is, as for every new one.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "waterTracking" BOOLEAN NOT NULL DEFAULT true;
