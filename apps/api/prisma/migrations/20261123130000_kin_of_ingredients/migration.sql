-- The ingredients that are the same food to most people who avoid one, offered together when one is ruled out.
ALTER TABLE "Ingredient" ADD COLUMN "kin" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
