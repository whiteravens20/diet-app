-- How a call to an AI provider ended, in place of a yes/no flag. The monthly
-- allowance counts completed calls only, so a call the provider never
-- completed (an error, a refused connection, a timeout) no longer uses it up.
CREATE TYPE "AiCallOutcome" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'TIMED_OUT');

ALTER TABLE "AiUsageLog" ADD COLUMN "outcome" "AiCallOutcome";

UPDATE "AiUsageLog"
SET "outcome" = CASE WHEN "success" THEN 'COMPLETED'::"AiCallOutcome" ELSE 'FAILED'::"AiCallOutcome" END;

ALTER TABLE "AiUsageLog" ALTER COLUMN "outcome" SET NOT NULL;

-- `fellBackToDeterministic` was never written as anything but false.
ALTER TABLE "AiUsageLog" DROP COLUMN "success", DROP COLUMN "fellBackToDeterministic";
