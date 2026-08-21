-- Network Pulse — split combined DX/VPN throughput into separate ingress and
-- egress columns. The old throughputAvgPercent/throughputMaxPercent were
-- computed as MAX(ingress, egress) [DX] or SUM(ingress, egress) [VPN] before
-- ever reaching this table, so there is no principled way to recover
-- per-direction history from them — existing network samples are dropped and
-- rebuilt on the next scan (up to a 450-day backfill, same as a first-ever
-- scan). Compute (ecs/asg) rows are entirely unaffected: this only touches
-- the network-only throughput columns.

-- AlterTable
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "throughputAvgPercent";
ALTER TABLE "capacity_utilization_samples" DROP COLUMN "throughputMaxPercent";
ALTER TABLE "capacity_utilization_samples" ADD COLUMN "throughputInAvgPercent" DOUBLE PRECISION;
ALTER TABLE "capacity_utilization_samples" ADD COLUMN "throughputInMaxPercent" DOUBLE PRECISION;
ALTER TABLE "capacity_utilization_samples" ADD COLUMN "throughputOutAvgPercent" DOUBLE PRECISION;
ALTER TABLE "capacity_utilization_samples" ADD COLUMN "throughputOutMaxPercent" DOUBLE PRECISION;
