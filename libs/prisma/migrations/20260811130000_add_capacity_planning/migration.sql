-- Capacity Planning (SA-004): hourly CPU/Mem utilization time series backing
-- the "Capacity Planning" report (installed vs. utilised vs. peak vs. >70%
-- breach instances) — the second STX compliance workbook, after Scaling
-- Events (SA-001/SA-003).
--
-- Persisted rather than queried live from CloudWatch at report time: 1-hour
-- resolution is only kept for 455 days, so a report spanning more than that
-- needs its own accumulated history — the same reasoning that already governs
-- scaling_audit_watermarks against CloudTrail's 90-day window.
--
-- One shared table for compute (ecs/asg) AND network (dx_connection/
-- vpn_tunnel, added later) rows — see the model comment in schema.prisma for
-- why a second near-identical table isn't warranted. No separate watermark
-- table either: "how far a resource has been polled" is answered by
-- MAX("bucketStartUtc") against the same unique key the upsert already uses.

-- CreateTable
CREATE TABLE "capacity_utilization_samples" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "clusterName" TEXT,
    "serviceName" TEXT,
    "asgName" TEXT,
    "bucketStartUtc" TIMESTAMPTZ(3) NOT NULL,
    "cpuAvg" DOUBLE PRECISION,
    "cpuMax" DOUBLE PRECISION,
    "memAvg" DOUBLE PRECISION,
    "memMax" DOUBLE PRECISION,
    "installedVcpu" DOUBLE PRECISION,
    "installedMemGiB" DOUBLE PRECISION,
    "stateUpOrDown" TEXT,
    "throughputAvgPercent" DOUBLE PRECISION,
    "throughputMaxPercent" DOUBLE PRECISION,
    "installedBandwidthMbps" DOUBLE PRECISION,
    "capturedByRunId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_utilization_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capacity_utilization_samples_tenantId_resourceType_resour_key"
    ON "capacity_utilization_samples"("tenantId", "resourceType", "resourceId", "bucketStartUtc");

-- CreateIndex
CREATE INDEX "capacity_utilization_samples_tenantId_resourceId_bucketSta_idx"
    ON "capacity_utilization_samples"("tenantId", "resourceId", "bucketStartUtc");

-- CreateIndex
CREATE INDEX "capacity_utilization_samples_tenantId_bucketStartUtc_idx"
    ON "capacity_utilization_samples"("tenantId", "bucketStartUtc");

-- CreateEnumCheck
ALTER TABLE "capacity_utilization_samples" ADD CONSTRAINT "capacity_utilization_samples_resource_type_check"
    CHECK ("resourceType" IN ('ecs', 'asg', 'dx_connection', 'vpn_tunnel'));

-- CreateTable
CREATE TABLE "capacity_planning_runs" (
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

    CONSTRAINT "capacity_planning_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capacity_planning_runs_tenantId_startedAt_idx" ON "capacity_planning_runs"("tenantId", "startedAt");

-- CreateEnumCheck
ALTER TABLE "capacity_planning_runs" ADD CONSTRAINT "capacity_planning_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'failed'));
ALTER TABLE "capacity_planning_runs" ADD CONSTRAINT "capacity_planning_runs_trigger_check"
    CHECK ("trigger" IN ('schedule', 'manual'));
