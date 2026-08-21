-- Network Availability & Bandwidth (SA-004, Phase D) — adds the account-type
-- discriminator needed to onboard a DX/VPN network-hub account (owns the
-- org's Transit Gateway, has no ECS/ASG of its own) alongside ordinary
-- workload accounts. The capacity_utilization_samples columns this phase
-- needs (throughputAvgPercent/throughputMaxPercent/installedBandwidthMbps)
-- were folded directly into the still-unshipped 20260811130000 migration
-- instead of a follow-up ALTER here — that migration had zero consuming code
-- yet, so there was nothing to migrate away from.
--
-- Additive and default-backfilling — no existing account changes meaning.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'workload';

-- CreateIndex
CREATE INDEX "accounts_tenantId_accountType_idx" ON "accounts"("tenantId", "accountType");

-- CreateEnumCheck
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_account_type_check"
    CHECK ("accountType" IN ('workload', 'network'));
