-- A link that confirms an address is sent again while it is valid, and the
-- row says when a mail with it last went out. For the rows there are, that
-- was when they were made.
ALTER TABLE "EmailVerificationToken" ADD COLUMN "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "EmailVerificationToken" SET "lastSentAt" = "createdAt";
