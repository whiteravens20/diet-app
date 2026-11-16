-- Which of OpenRouter's endpoints may serve a request of an account's own OpenRouter key, by what they do with its data.
CREATE TYPE "AiDataPolicy" AS ENUM ('any', 'no_training', 'no_retention');

ALTER TABLE "AiProviderConfig" ADD COLUMN "dataPolicy" "AiDataPolicy" NOT NULL DEFAULT 'no_training';
