-- The codes with which an application signs a browser in to its account: each
-- good for a minute and once, kept as a hash, and counted for an account over
-- the last hour.
-- CreateTable
CREATE TABLE "BrowserSignInCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowserSignInCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserSignInCode_codeHash_key" ON "BrowserSignInCode"("codeHash");

-- CreateIndex
CREATE INDEX "BrowserSignInCode_userId_createdAt_idx" ON "BrowserSignInCode"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BrowserSignInCode" ADD CONSTRAINT "BrowserSignInCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
