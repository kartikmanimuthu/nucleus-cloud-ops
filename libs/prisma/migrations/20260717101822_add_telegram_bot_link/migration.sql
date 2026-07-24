/*
  Warnings:

  - You are about to drop the column `contentHash` on the `inventory_resources` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "agent_memories_embedding_hnsw";

-- DropIndex
DROP INDEX "idx_inventory_search_vector";

-- DropIndex
DROP INDEX "idx_kb_document_chunks_embedding";

-- AlterTable
ALTER TABLE "inventory_resources" DROP COLUMN "contentHash";

-- AlterTable
ALTER TABLE "inventory_sync_status" ALTER COLUMN "errors" SET DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "telegram_bot_links" (
    "id" TEXT NOT NULL,
    "secretToken" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_bot_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_bot_links_secretToken_key" ON "telegram_bot_links"("secretToken");

-- CreateIndex
CREATE INDEX "telegram_bot_links_tenantId_idx" ON "telegram_bot_links"("tenantId");

-- AddForeignKey
ALTER TABLE "telegram_bot_links" ADD CONSTRAINT "telegram_bot_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
