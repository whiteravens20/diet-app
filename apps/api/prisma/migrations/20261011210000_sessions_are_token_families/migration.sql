-- The tokens of one session are kept together, and a used one is told from
-- one that was ended. A token from before is a session of its own, which
-- ends ninety days after it was made.
ALTER TABLE "RefreshToken"
  ADD COLUMN "familyId" TEXT,
  ADD COLUMN "familyExpiresAt" TIMESTAMP(3),
  ADD COLUMN "label" TEXT,
  ADD COLUMN "rotatedAt" TIMESTAMP(3);

UPDATE "RefreshToken" SET "familyId" = "id", "familyExpiresAt" = "createdAt" + INTERVAL '90 days';

ALTER TABLE "RefreshToken"
  ALTER COLUMN "familyId" SET NOT NULL,
  ALTER COLUMN "familyExpiresAt" SET NOT NULL;

CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
