-- DropIndex
DROP INDEX "custom_roles_tenantId_name_key";

-- DropIndex
DROP INDEX "idx_inventory_resources_embedding";

-- AlterTable
ALTER TABLE "custom_roles" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'custom',
ALTER COLUMN "tenantId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "custom_roles_type_idx" ON "custom_roles"("type");
