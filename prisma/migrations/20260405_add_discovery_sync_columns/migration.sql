-- Add jobRunId to inventory_resources for scan traceability
ALTER TABLE "inventory_resources" ADD COLUMN "jobRunId" TEXT;

-- Add lastSyncedAt and lastSyncResourceCount to accounts for sync status tracking
ALTER TABLE "accounts" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "accounts" ADD COLUMN "lastSyncResourceCount" INTEGER;
