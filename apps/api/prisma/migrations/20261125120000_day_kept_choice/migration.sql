-- The user's own choice of a day's portions ("Cofnij ostatnie przeliczenie", "Rozłóż na resztę planu", "Zostaw porcje
-- jak są"), which the changes he does not make himself leave as they are. Null for every day there is.
ALTER TABLE "MealPlanDay" ADD COLUMN "keptChoice" TEXT,
ADD COLUMN "keptAt" TIMESTAMP(3);
