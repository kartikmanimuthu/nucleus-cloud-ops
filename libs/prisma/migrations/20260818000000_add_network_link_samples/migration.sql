-- Network Pulse — Direct Connect / VPN tunnel bandwidth + availability samples
-- for Scale Sentinel. Relocated into the scaling-audit module (see
-- jobs/scaling-audit/services/network-client.ts and
-- network-cloudwatch-client.ts) — a prior incarnation of this table
-- (capacity_utilization_samples, dx_connection/vpn_tunnel rows) was removed in
-- 20260812150000_remove_network_pulse; this is a fresh table, not a revival of
-- the old one, and keeps ingress/egress throughput as separate columns from
-- the start (the old table's throughputAvgPercent/MaxPercent collapsed them —
-- see 20260812010000_split_throughput_direction for why that was wrong).
--
-- Hand-authored per CLAUDE.md — prisma migrate dev would attempt destructive
-- drift-correction against this repo's other raw-SQL-managed objects.

-- ── CreateTable: network_link_samples ─────────────────────────────────────────
CREATE TABLE "network_link_samples" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,

    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "displayName" TEXT,

    "installedBandwidthMbps" DOUBLE PRECISION,
    "bpsAvgIn" DOUBLE PRECISION,
    "bpsMaxIn" DOUBLE PRECISION,
    "bpsAvgOut" DOUBLE PRECISION,
    "bpsMaxOut" DOUBLE PRECISION,
    "stateUp" BOOLEAN,

    "bucketStartUtc" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_link_samples_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "network_link_samples_tenantId_resourceType_resourceId_buc_key"
    ON "network_link_samples"("tenantId", "resourceType", "resourceId", "bucketStartUtc");
CREATE INDEX "network_link_samples_tenantId_bucketStartUtc_idx" ON "network_link_samples"("tenantId", "bucketStartUtc");

-- ── CHECK constraint for the string enum (Prisma 5 cannot emit these) ────────
ALTER TABLE "network_link_samples" ADD CONSTRAINT "network_link_samples_resource_type_check"
    CHECK ("resourceType" IN ('dx_connection', 'vpn_tunnel'));
