-- F10: per-user AI mode picker.
--
-- `aiMode = 'none'` (default) means every AI feature falls back to the
-- deterministic engine — no provider call ever leaves the instance, even if
-- the user has BYOK rows or the operator has admin defaults configured.
-- `aiMode = 'admin'` routes through the operator's AI_DEFAULT_PROVIDER /
-- AI_DEFAULT_MODEL, capped at AI_ADMIN_USER_WEEKLY_LIMIT (default 10) rolling
-- 7-day requests per user. `aiMode = 'byok'` routes exclusively through the
-- user's own AiProviderConfig rows with no quota.
ALTER TABLE "User"
  ADD COLUMN "aiMode" TEXT NOT NULL DEFAULT 'none';

-- Quota accounting reads AiUsageLog filtered by (userId, mode='admin',
-- createdAt >= now() - interval '7 days'). Historical rows pre-dating this
-- migration are nullable so they don't count against any user.
ALTER TABLE "AiUsageLog"
  ADD COLUMN "mode" TEXT;

-- Hot path for the quota guard: per-user rolling window.
CREATE INDEX "AiUsageLog_userId_mode_createdAt_idx"
  ON "AiUsageLog"("userId", "mode", "createdAt");
