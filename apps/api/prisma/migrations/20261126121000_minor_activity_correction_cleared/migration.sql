-- Under 18 maintenance counts activity from moderate on. A correction from the real expenditure kept by a
-- profile under 18 at a sedentary or light level was measured against the lower maintenance and would count
-- twice: it goes, and the next working out proposes one against the new maintenance.
UPDATE "Profile"
SET "expenditureCorrectionKcal" = NULL
WHERE "age" < 18
  AND "activityLevel" IN ('sedentary', 'light')
  AND "expenditureCorrectionKcal" IS NOT NULL;
