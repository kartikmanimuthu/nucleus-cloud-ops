-- Add isCurrent flag to InventoryResource for batch reconciliation
-- This column tracks whether a resource is the most recent version from discovery

-- 1. Add the isCurrent column with default true
ALTER TABLE "inventory_resources" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true;

-- 2. Drop old indexes (they will be replaced with versions that include isCurrent)
DROP INDEX IF EXISTS "inventory_resources_tenantId_resourceType_idx";
DROP INDEX IF EXISTS "inventory_resources_tenantId_accountId_idx";

-- 3. Create new indexes that include isCurrent for filtering
CREATE INDEX "inventory_resources_tenantId_resourceType_isCurrent_idx" ON "inventory_resources"("tenantId", "resourceType", "isCurrent");
CREATE INDEX "inventory_resources_tenantId_accountId_isCurrent_idx" ON "inventory_resources"("tenantId", "accountId", "isCurrent");
