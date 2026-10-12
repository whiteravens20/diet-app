-- A recipe had a score of its own for how well its ingredients are used again.
-- Nothing ever worked it out: how a plan uses ingredients again is counted on the plan.
ALTER TABLE "Recipe" DROP COLUMN "reuseScore";
