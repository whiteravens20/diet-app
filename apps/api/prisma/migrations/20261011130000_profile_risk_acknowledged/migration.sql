-- When somebody under 18 or underweight said they understand the risk of
-- losing weight. Without it their loss goal is planned as maintenance.
ALTER TABLE "Profile" ADD COLUMN "riskAcknowledgedAt" TIMESTAMP(3);
