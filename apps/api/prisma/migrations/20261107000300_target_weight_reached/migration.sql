-- The day until which "Nie teraz" puts off the card that says a profile's target weight is reached.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "targetReachedLaterUntil" DATE;
