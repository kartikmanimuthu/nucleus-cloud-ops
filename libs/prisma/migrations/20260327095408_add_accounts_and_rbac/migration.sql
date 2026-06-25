-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleArn" TEXT NOT NULL,
    "externalId" TEXT,
    "regions" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "connectionStatus" TEXT NOT NULL DEFAULT 'unknown',
    "connectionError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "updatedBy" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tenant_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL,

    CONSTRAINT "user_tenant_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_tenant_roles_role_check" CHECK (role IN ('SuperAdmin','TenantAdmin','TenantOperator','TenantViewer'))
);

-- CreateIndex
CREATE INDEX "accounts_tenantId_idx" ON "accounts"("tenantId");

-- CreateIndex
CREATE INDEX "accounts_tenantId_active_idx" ON "accounts"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_tenantId_accountId_key" ON "accounts"("tenantId", "accountId");

-- CreateIndex
CREATE INDEX "user_tenant_roles_tenantId_idx" ON "user_tenant_roles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_roles_userId_tenantId_key" ON "user_tenant_roles"("userId", "tenantId");
