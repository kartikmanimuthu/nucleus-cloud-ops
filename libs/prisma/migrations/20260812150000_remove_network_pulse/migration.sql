-- Remove Network Pulse (formerly Network Sentinel) entirely, per user request.
-- This drops the whole DX/VPN monitoring capability: the per-account
-- workload/network distinction, the Network Pulse on/off switch, its run
-- history table, and the network-only columns on the shared
-- capacity_utilization_samples table. Compute (ecs/asg) capacity planning
-- rows and everything else on Account are entirely unaffected.

-- DropTable
DROP TABLE "network_pulse_runs";

-- AlterTable: accounts — drop accountType (workload/network) and networkPulseEnabled
DROP INDEX "accounts_tenantId_accountType_idx";
DROP INDEX "accounts_tenantId_networkPulseEnabled_idx";
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_account_type_check";
ALTER TABLE "accounts" DROP COLUMN "accountType";
ALTER TABLE "accounts" DROP COLUMN "networkPulseEnabled";

-- AlterTable: capacity_utilization_samples — drop network-only columns and
-- narrow the resourceType CHECK back to compute-only values. Existing
-- dx_connection/vpn_tunnel rows (real Network Pulse scan history) are
-- deleted first — they'd otherwise violate the narrowed CHECK, and there's
-- no compute equivalent to migrate them to now that the feature is gone.
DELETE FROM "capacity_utilization_samples" WHERE "resourceType" NOT IN ('ecs', 'asg');
ALTER TABLE "capacity_utilization_samples" DROP CONSTRAINT "capacity_utilization_samples_resource_type_check";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "stateUpOrDown";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "throughputInAvgPercent";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "throughputInMaxPercent";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "throughputOutAvgPercent";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "throughputOutMaxPercent";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "installedBandwidthMbps";
ALTER TABLE "capacity_utilization_samples" ADD CONSTRAINT "capacity_utilization_samples_resource_type_check"
    CHECK ("resourceType" IN ('ecs', 'asg'));
