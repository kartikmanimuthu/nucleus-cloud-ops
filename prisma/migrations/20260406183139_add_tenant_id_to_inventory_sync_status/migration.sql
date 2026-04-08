/*
  Warnings:

  - You are about to drop the column `search_vector` on the `inventory_resources` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "idx_inventory_search_vector";

-- AlterTable
ALTER TABLE "inventory_resources" DROP COLUMN "search_vector",
ADD COLUMN     "searchVector" tsvector;

-- AlterTable
ALTER TABLE "inventory_sync_status" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "inventory_sync_status_tenantId_syncedAt_idx" ON "inventory_sync_status"("tenantId", "syncedAt");
