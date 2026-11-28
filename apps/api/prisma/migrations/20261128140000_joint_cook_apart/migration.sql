-- Whether the dishes both people of a joint plan eat are cooked each portion apart: what new shared meals take. The
-- joint plans made before it cooked them in one pot.
ALTER TABLE "JointPlan" ADD COLUMN "cookApart" BOOLEAN NOT NULL DEFAULT false;
