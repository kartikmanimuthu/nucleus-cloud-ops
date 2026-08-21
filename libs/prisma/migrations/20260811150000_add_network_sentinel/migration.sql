-- Network Sentinel — splits DX/VPN/Transit-Gateway network monitoring out of
-- Scale Sentinel's Capacity Planning report into its own module. The two
-- modules now have independent on/off switches (this one does NOT reuse
-- scalingAuditEnabled) and independent run-history tables. The data table
-- (capacity_utilization_samples) is unchanged and stays shared — both
-- modules' worker jobs write into it, discriminated by resourceType.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "networkMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any account already onboarded as accountType='network' that had
-- scalingAuditEnabled=true was relying on that flag to get DX/VPN scanned
-- (the old, shared-switch behavior). Carry that opt-in forward onto the new
-- dedicated flag so this split doesn't silently stop an existing scan.
UPDATE "accounts" SET "networkMonitoringEnabled" = "scalingAuditEnabled" WHERE "accountType" = 'network';

-- CreateIndex
CREATE INDEX "accounts_tenantId_networkMonitoringEnabled_idx" ON "accounts"("tenantId", "networkMonitoringEnabled");

-- CreateTable
CREATE TABLE "network_monitoring_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "accountsScanned" INTEGER NOT NULL DEFAULT 0,
    "resourcesScanned" INTEGER NOT NULL DEFAULT 0,
    "samplesWritten" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "network_monitoring_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "network_monitoring_runs_tenantId_startedAt_idx" ON "network_monitoring_runs"("tenantId", "startedAt");

-- CreateEnumCheck
ALTER TABLE "network_monitoring_runs" ADD CONSTRAINT "network_monitoring_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed'));
ALTER TABLE "network_monitoring_runs" ADD CONSTRAINT "network_monitoring_runs_trigger_check"
    CHECK ("trigger" IN ('schedule', 'manual'));
