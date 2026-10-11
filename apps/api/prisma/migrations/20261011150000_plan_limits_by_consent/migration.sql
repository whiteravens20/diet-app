-- No plan made so far was asked which of its limits may give way: none may
-- when it is made again, until its owner says which.
UPDATE "MealPlan" SET "options" = "options" || '{"allowRelaxations": []}'::jsonb;
