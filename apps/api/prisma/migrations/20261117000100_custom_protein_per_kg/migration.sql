-- The custom diet's protein in grams per kilogram of the profile's weight; null for the way of the split alone.
ALTER TABLE "Profile" ADD COLUMN "customProteinPerKg" DOUBLE PRECISION;
