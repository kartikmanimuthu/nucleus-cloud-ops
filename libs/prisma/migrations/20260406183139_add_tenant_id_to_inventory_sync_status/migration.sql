-- Add tenantId column to inventory_sync_status
ALTER TABLE "inventory_sync_status" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "inventory_sync_status_tenantId_syncedAt_idx" ON "inventory_sync_status"("tenantId", "syncedAt");
