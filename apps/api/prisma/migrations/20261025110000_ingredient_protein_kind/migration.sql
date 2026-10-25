-- The kind of protein a food is: chicken, fish, eggs and so on, or none.
CREATE TYPE "ProteinKind" AS ENUM (
  'chicken', 'turkey', 'beef', 'pork', 'fish', 'seafood', 'eggs', 'dairy', 'legumes'
);

ALTER TABLE "Ingredient" ADD COLUMN "proteinKind" "ProteinKind";
