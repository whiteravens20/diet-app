-- A second step of signing in: a code from an authenticator app, for an
-- account that sets it up and for the administrator. The secret the codes
-- are made from, the codes that stand in for the app once each, and what an
-- account holds between its password and its code. A session says when it
-- passed the second step.
ALTER TABLE "RefreshToken" ADD COLUMN "secondFactorAt" TIMESTAMP(3);

CREATE TABLE "SecondFactor" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "secretEncrypted" TEXT NOT NULL,
    "lastStep" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecondFactor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "secondFactorId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SignInChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignInChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SecondFactor_userId_key" ON "SecondFactor"("userId");

CREATE INDEX "RecoveryCode_secondFactorId_idx" ON "RecoveryCode"("secondFactorId");

CREATE UNIQUE INDEX "SignInChallenge_tokenHash_key" ON "SignInChallenge"("tokenHash");

CREATE INDEX "SignInChallenge_userId_idx" ON "SignInChallenge"("userId");

ALTER TABLE "SecondFactor" ADD CONSTRAINT "SecondFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_secondFactorId_fkey" FOREIGN KEY ("secondFactorId") REFERENCES "SecondFactor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SignInChallenge" ADD CONSTRAINT "SignInChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
