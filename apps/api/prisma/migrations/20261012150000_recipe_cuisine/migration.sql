-- The cuisine a recipe belongs to, when it belongs to one. The catalogue
-- update fills it for the recipes that ship with one.
ALTER TABLE "Recipe" ADD COLUMN "cuisine" TEXT;

-- The cuisines a profile prefers are the cuisines a recipe can have from now
-- on. What was kept before was free text that nothing read: what names one of
-- those cuisines stays, the rest goes.
UPDATE "ProfilePreference"
   SET "preferredCuisines" = ARRAY(
         SELECT kept FROM unnest("preferredCuisines") AS kept
          WHERE kept IN ('polish', 'italian', 'asian', 'mediterranean', 'middle_eastern', 'mexican', 'american', 'indian')
       )
 WHERE cardinality("preferredCuisines") > 0;
