-- Network Sentinel → Network Pulse rename. Purely a naming change — no
-- behavior, no permission, no data change. The previous migration
-- (20260811150000_add_network_sentinel) is left untouched (already applied,
-- Prisma tracks it by checksum); this is a separate additive migration that
-- renames the column/table/constraints/indexes it created.

-- AlterTable
ALTER TABLE "accounts" RENAME COLUMN "networkMonitoringEnabled" TO "networkPulseEnabled";

-- RenameIndex
ALTER INDEX "accounts_tenantId_networkMonitoringEnabled_idx" RENAME TO "accounts_tenantId_networkPulseEnabled_idx";

-- RenameTable
ALTER TABLE "network_monitoring_runs" RENAME TO "network_pulse_runs";

-- RenameConstraint
ALTER TABLE "network_pulse_runs" RENAME CONSTRAINT "network_monitoring_runs_pkey" TO "network_pulse_runs_pkey";
ALTER TABLE "network_pulse_runs" RENAME CONSTRAINT "network_monitoring_runs_status_check" TO "network_pulse_runs_status_check";
ALTER TABLE "network_pulse_runs" RENAME CONSTRAINT "network_monitoring_runs_trigger_check" TO "network_pulse_runs_trigger_check";

-- RenameIndex
ALTER INDEX "network_monitoring_runs_tenantId_startedAt_idx" RENAME TO "network_pulse_runs_tenantId_startedAt_idx";
