-- A recipe's diet tags are worked out from its ingredients from now on, never
-- typed. This brings the rows that already exist in line once, with the same
-- rule the application applies on every later write:
--
--   vegetarian, vegan, mediterranean: every ingredient lists the diet;
--   low_carb: at most 26 % of the energy from carbohydrate; keto: at most 10 %.
--
-- "balanced", "high_protein" and "custom" stop being tags: a plan on one of
-- those diets takes any recipe. A recipe without ingredients, or without
-- energy, qualifies for nothing.
UPDATE "Recipe" r
SET "dietTags" = ARRAY(
    SELECT diet.tag
    FROM unnest(ARRAY['vegetarian', 'vegan', 'mediterranean', 'low_carb', 'keto']) WITH ORDINALITY AS diet(tag, position)
    WHERE r."caloriesPerServing" > 0
      AND EXISTS (SELECT 1 FROM "RecipeIngredient" line WHERE line."recipeId" = r.id)
      AND CASE diet.tag
            WHEN 'low_carb' THEN r."carbsPerServing" * 4 / r."caloriesPerServing" <= 0.26
            WHEN 'keto' THEN r."carbsPerServing" * 4 / r."caloriesPerServing" <= 0.10
            ELSE NOT EXISTS (
              SELECT 1
              FROM "RecipeIngredient" line
              JOIN "Ingredient" ingredient ON ingredient.id = line."ingredientId"
              WHERE line."recipeId" = r.id
                AND NOT (diet.tag = ANY (ingredient."dietCompatibility"::text[]))
            )
          END
    ORDER BY diet.position
);
