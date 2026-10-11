-- A report says what the pantry had to do with the plan, not only whether it
-- counted. Of the reports kept so far only that much is known: where the
-- pantry did not count, it is taken to have been empty.
UPDATE "MealPlan"
SET "report" = ("report" - 'pantryBiasApplied')
  || jsonb_build_object('pantry', CASE WHEN ("report" ->> 'pantryBiasApplied')::boolean THEN 'counted' ELSE 'empty' END)
WHERE "report" ? 'pantryBiasApplied';
