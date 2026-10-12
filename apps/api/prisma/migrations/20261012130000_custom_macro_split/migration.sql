-- The split of a day's energy that the custom diet aims at: a profile says
-- its own, and a plan keeps the one it was made with.
ALTER TABLE "Profile" ADD COLUMN "customMacroSplit" JSONB;
ALTER TABLE "MealPlan" ADD COLUMN "macroSplit" JSONB;

-- Until now the custom diet aimed at the balanced split. The profiles and the
-- plans that are on it go on aiming there, and from now on they say so.
UPDATE "Profile" SET "customMacroSplit" = '{"protein": 25, "fat": 30, "carbs": 45}' WHERE "dietType" = 'custom';
UPDATE "MealPlan" SET "macroSplit" = '{"protein": 25, "fat": 30, "carbs": 45}' WHERE "dietType" = 'custom';
