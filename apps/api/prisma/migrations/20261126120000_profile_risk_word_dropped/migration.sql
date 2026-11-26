-- No word lets a loss be planned for a body under 18 or underweight any more: such a body is held at
-- maintenance for as long as it is so, and the time the word was given goes.
ALTER TABLE "Profile" DROP COLUMN "riskAcknowledgedAt";
