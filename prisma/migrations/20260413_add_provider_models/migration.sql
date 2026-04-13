-- CreateTable
CREATE TABLE "provider_models" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible',
    "base_url" TEXT NOT NULL,
    "api_key" TEXT,
    "models" JSONB NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_models_tenant_id_idx" ON "provider_models"("tenant_id");

-- AddForeignKey
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
