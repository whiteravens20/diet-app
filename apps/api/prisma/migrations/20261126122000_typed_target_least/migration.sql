-- A calorie target somebody types is at least 1200 kcal, or the body's maintenance by the formula where that
-- is lower (never under 800). A profile's target typed under that before is raised to it. The formula is the
-- engine's: Mifflin-St Jeor rounded, times the activity multiplier (under 18 at least moderate's), rounded.
UPDATE "Profile" AS p
SET "manualCalorieTarget" = least_target.kcal
FROM (
  SELECT
    "id",
    GREATEST(800, LEAST(1200, round(
      round((10 * "weightKg" + 6.25 * "heightCm" - 5 * "age"
        + CASE "sex" WHEN 'male' THEN 5 WHEN 'female' THEN -161 ELSE -78 END)::numeric)
      * GREATEST(
          CASE "activityLevel"
            WHEN 'sedentary' THEN 1.4
            WHEN 'light' THEN 1.5
            WHEN 'moderate' THEN 1.6
            WHEN 'active' THEN 1.8
            ELSE 2.0
          END,
          CASE WHEN "age" < 18 THEN 1.6 ELSE 0 END
        )
    )))::int AS kcal
  FROM "Profile"
  WHERE "manualCalorieTarget" IS NOT NULL
) AS least_target
WHERE p."id" = least_target."id"
  AND p."manualCalorieTarget" < least_target.kcal;
