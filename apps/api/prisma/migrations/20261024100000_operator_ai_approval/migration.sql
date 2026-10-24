-- When the operator approved an account for its AI provider, in the admin panel.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "operatorAiApprovedAt" TIMESTAMP(3);
