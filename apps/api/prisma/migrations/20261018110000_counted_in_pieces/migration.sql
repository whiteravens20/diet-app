-- What is counted (eggs, slices, cloves) is kept in its pieces alone. Its rows
-- in grams or millilitres join its row in pieces: their amounts turned into
-- pieces and added, the earliest best-before date kept, and no row beyond the
-- 1000 pieces a row may hold. What a shopping row took from such rows, or put
-- into them, is written in pieces too, so that undoing it gives it back to the
-- row in pieces instead of making a row in grams again.
INSERT INTO "InventoryItem" ("id", "profileId", "ingredientId", "quantity", "unit", "bestBefore", "updatedAt")
SELECT gen_random_uuid()::text, i."profileId", i."ingredientId",
       LEAST(SUM(CASE i."unit" WHEN 'g' THEN i."quantity" / g."gramsPerPiece"
                               ELSE i."quantity" * g."density" / g."gramsPerPiece" END), 1000),
       'piece', MIN(i."bestBefore"), CURRENT_TIMESTAMP
FROM "InventoryItem" i
JOIN "Ingredient" g ON g."id" = i."ingredientId"
WHERE g."displayUnit" IS NOT NULL
  AND g."gramsPerPiece" > 0
  AND (g."canonicalUnit" <> 'ml' OR g."density" > 0)
  AND (i."unit" = 'g' OR (i."unit" = 'ml' AND g."density" > 0))
GROUP BY i."profileId", i."ingredientId"
ON CONFLICT ("profileId", "ingredientId", "unit") DO UPDATE
SET "quantity" = LEAST("InventoryItem"."quantity" + EXCLUDED."quantity", 1000),
    "bestBefore" = LEAST("InventoryItem"."bestBefore", EXCLUDED."bestBefore"),
    "updatedAt" = CURRENT_TIMESTAMP;

DELETE FROM "InventoryItem" i
USING "Ingredient" g
WHERE g."id" = i."ingredientId"
  AND g."displayUnit" IS NOT NULL
  AND g."gramsPerPiece" > 0
  AND (g."canonicalUnit" <> 'ml' OR g."density" > 0)
  AND (i."unit" = 'g' OR (i."unit" = 'ml' AND g."density" > 0));

UPDATE "ShoppingListItem" s
SET "pantryMoves" = (
  SELECT jsonb_agg(
           CASE WHEN jsonb_typeof(m -> 'quantity') = 'number'
                 AND (m ->> 'unit' = 'g' OR (m ->> 'unit' = 'ml' AND g."density" > 0))
                THEN m || jsonb_build_object(
                       'unit', 'piece',
                       'quantity', CASE m ->> 'unit'
                                     WHEN 'g' THEN (m ->> 'quantity')::double precision / g."gramsPerPiece"
                                     ELSE (m ->> 'quantity')::double precision * g."density" / g."gramsPerPiece"
                                   END)
                ELSE m
           END
           ORDER BY place)
  FROM jsonb_array_elements(s."pantryMoves") WITH ORDINALITY AS moved(m, place)
)
FROM "Ingredient" g
WHERE g."id" = s."ingredientId"
  AND g."displayUnit" IS NOT NULL
  AND g."gramsPerPiece" > 0
  AND (g."canonicalUnit" <> 'ml' OR g."density" > 0)
  AND CASE WHEN jsonb_typeof(s."pantryMoves") = 'array' THEN jsonb_array_length(s."pantryMoves") > 0 ELSE false END;
