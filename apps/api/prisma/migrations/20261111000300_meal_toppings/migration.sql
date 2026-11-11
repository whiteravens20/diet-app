-- A topping on one person's plate beside a dish of a joint plan, and its amount.
ALTER TABLE "PlannedMeal" ADD COLUMN "toppingKey" TEXT;
ALTER TABLE "PlannedMeal" ADD COLUMN "toppingAmount" DOUBLE PRECISION;
