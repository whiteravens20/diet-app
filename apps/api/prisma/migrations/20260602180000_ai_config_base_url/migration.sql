-- Per-config Ollama base URL. Required at the API layer when provider=ollama
-- so users can point at a non-default host (LAN box, tunneled instance, etc.)
-- without depending on the operator's env. Nullable in DB: other providers
-- don't use it, and admin-default rows still derive theirs from env.

ALTER TABLE "AiProviderConfig" ADD COLUMN "baseUrl" TEXT;
