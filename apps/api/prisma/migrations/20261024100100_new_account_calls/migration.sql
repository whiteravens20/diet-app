-- Of the calls kept from deleted accounts, those of accounts that were still new.
-- AlterTable
ALTER TABLE "AiUsageOfDeletedAccounts" ADD COLUMN     "newAccountCalls" INTEGER NOT NULL DEFAULT 0;
