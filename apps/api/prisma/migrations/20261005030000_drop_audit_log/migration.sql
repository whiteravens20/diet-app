-- Drop the audit-log table. Nothing ever wrote to it or read from it, so it
-- held no rows; the model is gone from schema.prisma with this migration.

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_userId_fkey";

-- DropTable
DROP TABLE "AuditLog";
