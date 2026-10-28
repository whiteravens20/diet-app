-- The keys clients send with an addition they may send again when its answer
-- is lost (`Idempotency-Key`), each kept with its account for a week and with
-- what the first request under it wrote.
CREATE TABLE "IdempotencyKey" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("userId","key")
);

CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
