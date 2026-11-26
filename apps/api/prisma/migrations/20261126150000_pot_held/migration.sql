-- Whether a meal eaten from a pot cooked already was held to what the pot holds by a sizing that would have given it more.
ALTER TABLE "PlannedMeal" ADD COLUMN "potHeld" BOOLEAN NOT NULL DEFAULT false;
