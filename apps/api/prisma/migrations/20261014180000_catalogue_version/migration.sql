-- What the plans of each diet reach is measured once for the shared recipes as
-- they are, and kept while they stay the same. Whether they stayed the same was
-- asked by a digest of every shared recipe and line, worked out at every look
-- at the administrator's statistics. The database now keeps a token instead,
-- and replaces it in the same transaction whenever a column the measure reads
-- changes in a shared recipe, in a line of one or in an ingredient: whichever
-- path writes, the change is marked, and a look reads one row.
CREATE TABLE "CatalogueVersion" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "token" TEXT NOT NULL,

    CONSTRAINT "CatalogueVersion_pkey" PRIMARY KEY ("id")
);

INSERT INTO "CatalogueVersion" ("id", "token") VALUES (1, gen_random_uuid()::text);

-- A new token, never one seen before: a count could come back to a number a
-- process still holds after its table was emptied.
CREATE FUNCTION catalogue_changed() RETURNS void LANGUAGE sql AS $$
  INSERT INTO "CatalogueVersion" ("id", "token") VALUES (1, gen_random_uuid()::text)
  ON CONFLICT ("id") DO UPDATE SET "token" = EXCLUDED."token";
$$;

-- A shared recipe is one no user owns. What the measure reads of it: its
-- servings, meals, diets and what a serving holds, and whether it is shared,
-- retired or deleted.
CREATE FUNCTION recipe_catalogue_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM catalogue_changed();
  ELSIF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM new_rows WHERE "createdByUserId" IS NULL) THEN PERFORM catalogue_changed(); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM old_rows WHERE "createdByUserId" IS NULL) THEN PERFORM catalogue_changed(); END IF;
  ELSIF EXISTS (
    SELECT 1 FROM new_rows n JOIN old_rows o ON o."id" = n."id"
     WHERE (o."createdByUserId" IS NULL OR n."createdByUserId" IS NULL)
       AND (n."servings", n."mealTypes", n."dietTags", n."caloriesPerServing", n."proteinPerServing",
            n."fatPerServing", n."carbsPerServing", n."createdByUserId", n."retiredAt", n."deletedAt")
           IS DISTINCT FROM
           (o."servings", o."mealTypes", o."dietTags", o."caloriesPerServing", o."proteinPerServing",
            o."fatPerServing", o."carbsPerServing", o."createdByUserId", o."retiredAt", o."deletedAt")
  ) THEN
    PERFORM catalogue_changed();
  END IF;
  RETURN NULL;
END;
$$;

-- A line of a shared recipe: which ingredient, how much and in what unit.
CREATE FUNCTION recipe_line_catalogue_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM catalogue_changed();
  ELSIF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM new_rows l JOIN "Recipe" r ON r."id" = l."recipeId" WHERE r."createdByUserId" IS NULL) THEN
      PERFORM catalogue_changed();
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM old_rows l JOIN "Recipe" r ON r."id" = l."recipeId" WHERE r."createdByUserId" IS NULL) THEN
      PERFORM catalogue_changed();
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM new_rows n JOIN old_rows o ON o."id" = n."id"
      JOIN "Recipe" r ON r."id" IN (n."recipeId", o."recipeId")
     WHERE r."createdByUserId" IS NULL
       AND (n."recipeId", n."ingredientId", n."quantity", n."unit")
           IS DISTINCT FROM (o."recipeId", o."ingredientId", o."quantity", o."unit")
  ) THEN
    PERFORM catalogue_changed();
  END IF;
  RETURN NULL;
END;
$$;

-- An ingredient, as a line converts and buys it. A new one touches no recipe
-- until a line names it, and one a line names cannot be deleted.
CREATE FUNCTION ingredient_catalogue_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM catalogue_changed();
  ELSIF EXISTS (
    SELECT 1 FROM new_rows n JOIN old_rows o ON o."id" = n."id"
     WHERE (n."canonicalUnit", n."gramsPerPiece", n."density", n."packSize", n."perishable")
           IS DISTINCT FROM (o."canonicalUnit", o."gramsPerPiece", o."density", o."packSize", o."perishable")
  ) THEN
    PERFORM catalogue_changed();
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Recipe_catalogue_insert" AFTER INSERT ON "Recipe"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION recipe_catalogue_changed();
CREATE TRIGGER "Recipe_catalogue_update" AFTER UPDATE ON "Recipe"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION recipe_catalogue_changed();
CREATE TRIGGER "Recipe_catalogue_delete" AFTER DELETE ON "Recipe"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION recipe_catalogue_changed();
CREATE TRIGGER "Recipe_catalogue_truncate" AFTER TRUNCATE ON "Recipe"
  FOR EACH STATEMENT EXECUTE FUNCTION recipe_catalogue_changed();

CREATE TRIGGER "RecipeIngredient_catalogue_insert" AFTER INSERT ON "RecipeIngredient"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION recipe_line_catalogue_changed();
CREATE TRIGGER "RecipeIngredient_catalogue_update" AFTER UPDATE ON "RecipeIngredient"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION recipe_line_catalogue_changed();
CREATE TRIGGER "RecipeIngredient_catalogue_delete" AFTER DELETE ON "RecipeIngredient"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION recipe_line_catalogue_changed();
CREATE TRIGGER "RecipeIngredient_catalogue_truncate" AFTER TRUNCATE ON "RecipeIngredient"
  FOR EACH STATEMENT EXECUTE FUNCTION recipe_line_catalogue_changed();

CREATE TRIGGER "Ingredient_catalogue_update" AFTER UPDATE ON "Ingredient"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION ingredient_catalogue_changed();
CREATE TRIGGER "Ingredient_catalogue_truncate" AFTER TRUNCATE ON "Ingredient"
  FOR EACH STATEMENT EXECUTE FUNCTION ingredient_catalogue_changed();
