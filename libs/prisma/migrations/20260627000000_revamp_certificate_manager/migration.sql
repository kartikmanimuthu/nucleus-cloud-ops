-- Certificate Manager revamp (Phase A: additive DDL + backfill).
-- Legacy material columns on "certificates" are RETAINED here for cutover and dropped
-- in a later migration once the app fully reads from certificate_versions.

-- AlterTable: add active-version pointer + relax legacy columns to nullable
ALTER TABLE "certificates" ADD COLUMN "activeVersionId" TEXT;
ALTER TABLE "certificates" ALTER COLUMN "notAfter" DROP NOT NULL;
ALTER TABLE "certificates" ALTER COLUMN "s3BodyKey" DROP NOT NULL;
ALTER TABLE "certificates" ALTER COLUMN "s3PrivateKeyKey" DROP NOT NULL;

-- CreateTable
CREATE TABLE "certificate_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "issuer" TEXT,
    "notBefore" TIMESTAMP(3),
    "notAfter" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT,
    "serialNumber" TEXT,
    "s3BodyKey" TEXT NOT NULL,
    "s3ChainKey" TEXT,
    "s3PrivateKeyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT NOT NULL,

    CONSTRAINT "certificate_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_deployments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "acmArn" TEXT,
    "acmDomainName" TEXT,
    "acmNotAfter" TIMESTAMP(3),
    "acmStatus" TEXT,
    "deployedVersionId" TEXT,
    "linkState" TEXT NOT NULL DEFAULT 'discovered',
    "inUseByCount" INTEGER NOT NULL DEFAULT 0,
    "lastScannedAt" TIMESTAMP(3),
    "lastDeployedAt" TIMESTAMP(3),

    CONSTRAINT "certificate_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_executions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "versionId" TEXT,
    "accountId" TEXT,
    "region" TEXT,
    "status" TEXT NOT NULL,
    "acmArn" TEXT,
    "message" TEXT,
    "details" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "triggeredBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_executions_pkey" PRIMARY KEY ("id")
);

-- Backfill: one v1 (active) version per existing certificate, copying material verbatim.
-- S3 objects are NOT moved — v1 keys point at the existing paths. fingerprint/serialNumber
-- are left NULL and lazy-computed by the app on first read/deploy.
INSERT INTO "certificate_versions" (
    "id", "tenantId", "certificateId", "version", "isActive",
    "issuer", "notBefore", "notAfter", "s3BodyKey", "s3ChainKey", "s3PrivateKeyKey",
    "status", "uploadedAt", "uploadedBy"
)
SELECT
    gen_random_uuid()::text, c."tenantId", c."id", 1, true,
    c."issuer", c."notBefore", c."notAfter", c."s3BodyKey", c."s3ChainKey", c."s3PrivateKeyKey",
    c."status", c."createdAt", c."createdBy"
FROM "certificates" c
WHERE c."s3BodyKey" IS NOT NULL AND c."notAfter" IS NOT NULL;

-- Backfill: point each certificate at its v1 version.
UPDATE "certificates" c
SET "activeVersionId" = v."id"
FROM "certificate_versions" v
WHERE v."certificateId" = c."id" AND v."version" = 1;

-- Backfill: deployment rows from the legacy associatedAccountIds array.
-- region = 'unknown' sentinel; first Discover reconciles these into real (region) rows.
INSERT INTO "certificate_deployments" (
    "id", "tenantId", "certificateId", "accountId", "region", "linkState", "inUseByCount"
)
SELECT DISTINCT
    gen_random_uuid()::text, c."tenantId", c."id", acct, 'unknown', 'discovered', 0
FROM "certificates" c, unnest(c."associatedAccountIds") AS acct
WHERE acct IS NOT NULL AND acct <> '';

-- CreateIndex
CREATE UNIQUE INDEX "certificate_versions_tenantId_certificateId_version_key" ON "certificate_versions"("tenantId", "certificateId", "version");

-- CreateIndex
CREATE INDEX "certificate_versions_tenantId_certificateId_idx" ON "certificate_versions"("tenantId", "certificateId");

-- CreateIndex: enforce at most one active version per certificate
CREATE UNIQUE INDEX "certificate_versions_one_active" ON "certificate_versions"("tenantId", "certificateId") WHERE "isActive" = true;

-- CreateIndex
CREATE UNIQUE INDEX "certificate_deployments_tenantId_certificateId_accountId_re_key" ON "certificate_deployments"("tenantId", "certificateId", "accountId", "region");

-- CreateIndex
CREATE INDEX "certificate_deployments_tenantId_certificateId_idx" ON "certificate_deployments"("tenantId", "certificateId");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_executions_tenantId_executionId_key" ON "certificate_executions"("tenantId", "executionId");

-- CreateIndex
CREATE INDEX "certificate_executions_tenantId_certificateId_startedAt_idx" ON "certificate_executions"("tenantId", "certificateId", "startedAt");

-- CreateIndex
CREATE INDEX "certificate_executions_expiresAt_idx" ON "certificate_executions"("expiresAt");
