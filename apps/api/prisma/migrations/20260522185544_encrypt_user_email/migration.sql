-- Email is no longer stored in plaintext. `emailIndex` is a keyed HMAC blind
-- index for unique lookups; `emailEncrypted` holds the AES-256-GCM ciphertext.

-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "email",
ADD COLUMN     "emailEncrypted" TEXT NOT NULL,
ADD COLUMN     "emailIndex" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_emailIndex_key" ON "User"("emailIndex");
