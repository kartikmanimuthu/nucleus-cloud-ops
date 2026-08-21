-- Scaling Audit (SA-001) — per-account opt-in, mirroring spotAutomationEnabled.
-- Hand-authored for the same reason as prior migrations in this feature and
-- 20260725201753_add_spot_guard: `prisma migrate dev` diffs against raw-SQL
-- managed objects elsewhere in this schema and proposes dropping them. This
-- migration is additive-only: one nullable-free column with a default, so
-- every existing row is immediately valid, plus its supporting index.

ALTER TABLE "accounts" ADD COLUMN "scalingAuditEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "accounts_tenantId_scalingAuditEnabled_idx" ON "accounts"("tenantId", "scalingAuditEnabled");
