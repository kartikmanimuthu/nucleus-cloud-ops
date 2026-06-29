-- Extend provider_models for the full multi-provider port (Bedrock/OpenAI/Anthropic/Ollama/vLLM/LM Studio/LiteLLM)
-- Adds encrypted credentials, region, selected chat/embedding models, and default-provider flag.

-- baseUrl becomes optional (Bedrock/OpenAI/Anthropic providers may not have a custom base URL)
ALTER TABLE "provider_models" ALTER COLUMN "base_url" DROP NOT NULL;

ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "region" TEXT;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "credentials" TEXT;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "chat_model" TEXT;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "embedding_dimensions" INTEGER;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "provider_models_tenant_id_is_default_idx" ON "provider_models" ("tenant_id", "is_default");
