-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domainName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "issuer" TEXT,
    "notBefore" TIMESTAMP(3),
    "notAfter" TIMESTAMP(3) NOT NULL,
    "s3BodyKey" TEXT NOT NULL,
    "s3ChainKey" TEXT,
    "s3PrivateKeyKey" TEXT NOT NULL,
    "associatedAccountIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tags" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "certificates_tenantId_idx" ON "certificates"("tenantId");
CREATE INDEX "certificates_tenantId_status_idx" ON "certificates"("tenantId", "status");
CREATE INDEX "certificates_tenantId_notAfter_idx" ON "certificates"("tenantId", "notAfter");
