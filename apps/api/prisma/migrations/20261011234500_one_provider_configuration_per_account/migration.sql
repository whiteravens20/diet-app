-- An account has one configuration of each provider. Two saves that arrived
-- together could leave two: of such rows the one that was changed last stays
-- (the newest by id where two were changed in the same moment), and what the
-- account had set is what it set last.
DELETE FROM "AiProviderConfig" doubled
USING "AiProviderConfig" kept
WHERE doubled."userId" = kept."userId"
  AND doubled."provider" = kept."provider"
  AND (doubled."updatedAt", doubled."id") < (kept."updatedAt", kept."id");

DROP INDEX "AiProviderConfig_userId_idx";

CREATE UNIQUE INDEX "AiProviderConfig_userId_provider_key" ON "AiProviderConfig"("userId", "provider");
