-- CreateTable
CREATE TABLE "connector_apps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "signingSecretEnc" TEXT,
    "botTokenEnc" TEXT,
    "botAccountLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'configured',
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountLabel" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenType" TEXT NOT NULL DEFAULT 'user',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_apps_tenantId_idx" ON "connector_apps"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_apps_tenantId_provider_key" ON "connector_apps"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "connector_connections_tenantId_provider_idx" ON "connector_connections"("tenantId", "provider");

-- CreateIndex
CREATE INDEX "connector_connections_tenantId_provider_status_idx" ON "connector_connections"("tenantId", "provider", "status");
