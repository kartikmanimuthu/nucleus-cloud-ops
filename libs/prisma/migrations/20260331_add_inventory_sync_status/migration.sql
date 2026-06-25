CREATE TABLE "inventory_sync_status" (
    "id"             TEXT NOT NULL,
    "scanId"         TEXT NOT NULL,
    "totalResources" INTEGER NOT NULL DEFAULT 0,
    "accountsSynced" INTEGER NOT NULL DEFAULT 0,
    "status"         TEXT NOT NULL DEFAULT 'completed',
    "syncedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_sync_status_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_sync_status_scanId_key" ON "inventory_sync_status"("scanId");
CREATE INDEX "inventory_sync_status_syncedAt_idx" ON "inventory_sync_status"("syncedAt");
